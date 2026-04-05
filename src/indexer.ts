import {
  Connection,
  PublicKey,
  ConfirmedSignatureInfo,
  ParsedTransactionWithMeta,
} from '@solana/web3.js';
import Database from 'better-sqlite3';
import { config } from './config';
import { logger } from './logger';
import { withRetry, sleep } from './retry';
import {
  AnchorIdl,
  generateSchemaSQL,
  getInstructionTableName,
  decodeInstructionArgs,
} from './idl';

export interface IndexerOptions {
  idl: AnchorIdl;
  programId: string;
  db: Database.Database;
  rpcUrl?: string;
}

export type IndexerMode = 'batch' | 'realtime';

export interface BatchOptions {
  fromSlot?: number;
  toSlot?: number;
  signatures?: string[];
}

export class SolanaIndexer {
  private connection: Connection;
  private db: Database.Database;
  private idl: AnchorIdl;
  private programId: PublicKey;
  private running = false;
  private shutdownRequested = false;

  constructor(opts: IndexerOptions) {
    this.connection = new Connection(opts.rpcUrl ?? config.RPC_URL, 'confirmed');
    this.db = opts.db;
    this.idl = opts.idl;
    this.programId = new PublicKey(opts.programId);

    // Initialize schema from IDL
    const ddl = generateSchemaSQL(opts.idl);
    this.db.exec(ddl);

    logger.info('Indexer initialized', {
      program: opts.idl.name,
      programId: opts.programId,
      instructions: opts.idl.instructions.map(ix => ix.name),
    });
  }

  // ─── State management ────────────────────────────────────────────────────────

  private getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM _indexer_state WHERE key = ?').get(key) as any;
    return row?.value ?? null;
  }

  private setState(key: string, value: string) {
    this.db.prepare(
      'INSERT OR REPLACE INTO _indexer_state (key, value) VALUES (?, ?)'
    ).run(key, value);
  }

  private getLastProcessedSlot(): number {
    const val = this.getState('last_processed_slot');
    return val ? parseInt(val) : 0;
  }

  private setLastProcessedSlot(slot: number) {
    this.setState('last_processed_slot', String(slot));
  }

  // ─── Transaction processing ───────────────────────────────────────────────

  private async fetchTx(signature: string): Promise<ParsedTransactionWithMeta | null> {
    return withRetry(
      () => this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      }),
      { maxAttempts: 5, initialDelayMs: 500 }
    );
  }

  private async fetchSignatures(before?: string, limit = 100): Promise<ConfirmedSignatureInfo[]> {
    return withRetry(
      () => this.connection.getSignaturesForAddress(
        this.programId,
        { before, limit },
        'confirmed'
      ),
      { maxAttempts: 5, initialDelayMs: 500 }
    );
  }

  private processTx(tx: ParsedTransactionWithMeta, signature: string) {
    if (!tx.meta || tx.meta.err) return;

    const slot = tx.slot;
    const blockTime = tx.blockTime ?? null;
    const message = tx.transaction.message as any;
    const instructions = message.instructions ?? [];

    for (const ix of instructions) {
      const programId = ix.programId?.toString();
      if (programId !== this.programId.toString()) continue;

      // Match instruction by discriminator or name
      const rawData = ix.data ? Buffer.from(ix.data, 'base64') : null;

      for (const idlIx of this.idl.instructions) {
        const tableName = getInstructionTableName(this.idl.name, idlIx.name);

        // Try to decode args
        const args = rawData
          ? decodeInstructionArgs(idlIx.args, new Uint8Array(rawData))
          : {};

        // Build accounts map
        const accountKeys = message.accountKeys ?? [];
        const accountValues: Record<string, string> = {};
        idlIx.accounts.forEach((acc, i) => {
          const key = accountKeys[i];
          accountValues[`account_${acc.name.toLowerCase()}`] = key?.pubkey?.toString() ?? null;
        });

        // Build row
        const row: Record<string, any> = {
          signature,
          slot,
          block_time: blockTime,
          ...accountValues,
          indexed_at: Date.now(),
        };

        for (const field of idlIx.args) {
          row[`arg_${field.name.toLowerCase()}`] = args[field.name] !== undefined
            ? String(args[field.name])
            : null;
        }

        const cols = Object.keys(row);
        const placeholders = cols.map(() => '?').join(', ');
        const values = cols.map(c => row[c]);

        try {
          this.db.prepare(
            `INSERT OR IGNORE INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})`
          ).run(...values);
        } catch (err: any) {
          logger.warn('Failed to insert row', { table: tableName, error: err.message });
        }

        // Only process first matching instruction per tx for now
        break;
      }
    }

    if (slot > this.getLastProcessedSlot()) {
      this.setLastProcessedSlot(slot);
    }
  }

  // ─── Batch mode ──────────────────────────────────────────────────────────────

  async runBatch(opts: BatchOptions = {}): Promise<number> {
    logger.info('Starting batch indexing', opts);
    let processed = 0;

    if (opts.signatures?.length) {
      // Process specific signatures
      for (const sig of opts.signatures) {
        const tx = await this.fetchTx(sig);
        if (tx) { this.processTx(tx, sig); processed++; }
      }
      return processed;
    }

    // Paginate through signatures
    let before: string | undefined;
    while (!this.shutdownRequested) {
      const sigs = await this.fetchSignatures(before, 100);
      if (!sigs.length) break;

      for (const sigInfo of sigs) {
        if (opts.fromSlot && sigInfo.slot < opts.fromSlot) { return processed; }
        if (opts.toSlot && sigInfo.slot > opts.toSlot) continue;

        const tx = await this.fetchTx(sigInfo.signature);
        if (tx) { this.processTx(tx, sigInfo.signature); processed++; }
        await sleep(50); // rate limit
      }

      before = sigs[sigs.length - 1].signature;
      logger.info('Batch progress', { processed, lastSlot: sigs[sigs.length - 1].slot });
    }

    logger.info('Batch indexing complete', { processed });
    return processed;
  }

  // ─── Real-time mode with cold start ──────────────────────────────────────────

  async runRealtime(): Promise<void> {
    this.running = true;
    logger.info('Starting real-time indexing with cold start');

    // Cold start: backfill missed transactions
    await this.backfill();

    // Real-time polling
    logger.info('Cold start complete, switching to real-time polling');
    while (this.running && !this.shutdownRequested) {
      try {
        await this.pollNew();
      } catch (err: any) {
        logger.error('Polling error', { error: err.message });
      }
      await sleep(config.POLL_INTERVAL_MS);
    }
  }

  private async backfill(): Promise<void> {
    const lastSlot = this.getLastProcessedSlot();
    logger.info('Backfilling', { fromSlot: lastSlot });

    let before: string | undefined;
    let backfilled = 0;

    while (!this.shutdownRequested) {
      const sigs = await this.fetchSignatures(before, 100);
      if (!sigs.length) break;

      const newSigs = sigs.filter(s => s.slot > lastSlot);
      if (!newSigs.length) break;

      for (const sigInfo of newSigs.reverse()) {
        const tx = await this.fetchTx(sigInfo.signature);
        if (tx) { this.processTx(tx, sigInfo.signature); backfilled++; }
        await sleep(50);
      }

      if (newSigs.length < sigs.length) break;
      before = sigs[sigs.length - 1].signature;
    }

    logger.info('Backfill complete', { backfilled });
  }

  private async pollNew(): Promise<void> {
    const sigs = await this.fetchSignatures(undefined, 10);
    const lastSlot = this.getLastProcessedSlot();

    for (const sigInfo of sigs) {
      if (sigInfo.slot <= lastSlot) continue;
      const tx = await this.fetchTx(sigInfo.signature);
      if (tx) { this.processTx(tx, sigInfo.signature); }
    }
  }

  // ─── Shutdown ─────────────────────────────────────────────────────────────

  stop() {
    logger.info('Graceful shutdown requested');
    this.shutdownRequested = true;
    this.running = false;
  }

  get isRunning() { return this.running; }
}
