import {
  Connection,
  PublicKey,
  ConfirmedSignatureInfo,
  ParsedTransactionWithMeta,
  AccountInfo,
} from '@solana/web3.js';
import Database from 'better-sqlite3';
import { config } from './config';
import { logger } from './logger';
import { withRetry, sleep } from './retry';
import {
  AnchorIdl,
  generateSchemaSQL,
  getInstructionTableName,
  getAccountTableName,
  buildDiscriminatorMap,
  matchInstruction,
  decodeInstructionArgs,
} from './idl';

export interface IndexerOptions {
  idl: AnchorIdl;
  programId: string;
  db: Database.Database;
  rpcUrl?: string;
}

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
  private discriminatorMap: Map<string, any>;

  constructor(opts: IndexerOptions) {
    this.connection = new Connection(opts.rpcUrl ?? config.RPC_URL, 'confirmed');
    this.db = opts.db;
    this.idl = opts.idl;
    this.programId = new PublicKey(opts.programId);
    this.discriminatorMap = buildDiscriminatorMap(opts.idl);

    const ddl = generateSchemaSQL(opts.idl);
    this.db.exec(ddl);

    logger.info('Indexer initialized', {
      program: opts.idl.name,
      programId: opts.programId,
      instructions: opts.idl.instructions.map(ix => ix.name),
    });
  }

  // ─── State ───────────────────────────────────────────────────────────────────

  private getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM _indexer_state WHERE key = ?').get(key) as any;
    return row?.value ?? null;
  }

  private setState(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO _indexer_state (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  private getLastProcessedSlot(): number {
    const val = this.getState('last_processed_slot');
    return val ? parseInt(val) : 0;
  }

  private setLastProcessedSlot(slot: number) {
    this.setState('last_processed_slot', String(slot));
  }

  // ─── RPC helpers ─────────────────────────────────────────────────────────────

  private fetchTx(signature: string): Promise<ParsedTransactionWithMeta | null> {
    return withRetry(
      () => this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      }),
      { maxAttempts: 5, initialDelayMs: 500 }
    );
  }

  private fetchSignatures(opts: { before?: string; until?: string; limit?: number } = {}): Promise<ConfirmedSignatureInfo[]> {
    return withRetry(
      () => this.connection.getSignaturesForAddress(
        this.programId,
        { before: opts.before, until: opts.until, limit: opts.limit ?? 100 },
        'confirmed'
      ),
      { maxAttempts: 5, initialDelayMs: 500 }
    );
  }

  private fetchAccountInfo(pubkey: PublicKey): Promise<AccountInfo<Buffer> | null> {
    return withRetry(
      () => this.connection.getAccountInfo(pubkey),
      { maxAttempts: 3, initialDelayMs: 500 }
    );
  }

  // ─── Transaction processing ───────────────────────────────────────────────

  /**
   * Process a single parsed transaction.
   * Uses discriminator matching to correctly identify which instruction was called.
   * All DB writes happen in a single transaction for atomicity.
   */
  private processTx(tx: ParsedTransactionWithMeta, signature: string): void {
    if (!tx.meta || tx.meta.err) return;

    const slot = tx.slot;
    const blockTime = tx.blockTime ?? null;
    const message = tx.transaction.message as any;
    const instructions: any[] = message.instructions ?? [];
    const accountKeys: any[] = message.accountKeys ?? [];

    const insertFn = this.db.transaction(() => {
      for (const ix of instructions) {
        // Only process instructions for our program
        if (ix.programId?.toString() !== this.programId.toString()) continue;

        // Decode raw data
        const rawData: Buffer | null = ix.data
          ? Buffer.from(ix.data, 'base64')
          : null;

        if (!rawData) continue;

        // Match by Anchor discriminator
        const idlIx = matchInstruction(rawData, this.discriminatorMap);
        if (!idlIx) {
          logger.debug('Unknown instruction discriminator', {
            signature,
            disc: rawData.slice(0, 8).toString('hex'),
          });
          continue;
        }

        const tableName = getInstructionTableName(this.idl.name, idlIx.name);

        // Decode args
        const args = decodeInstructionArgs(idlIx.args, rawData);

        // Map accounts by position
        const accountValues: Record<string, string | null> = {};
        idlIx.accounts.forEach((acc, i) => {
          const key = accountKeys[i];
          accountValues[`account_${acc.name.toLowerCase()}`] = key?.pubkey?.toString() ?? null;
        });

        const row: Record<string, any> = {
          signature,
          slot,
          block_time: blockTime,
          ...accountValues,
          indexed_at: Date.now(),
        };

        for (const field of idlIx.args) {
          const val = args[field.name];
          row[`arg_${field.name.toLowerCase()}`] = val !== undefined && val !== null ? String(val) : null;
        }

        const cols = Object.keys(row);
        const placeholders = cols.map(() => '?').join(', ');

        try {
          this.db.prepare(
            `INSERT OR IGNORE INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})`
          ).run(...cols.map(c => row[c]));

          logger.debug('Indexed instruction', { instruction: idlIx.name, signature, slot });
        } catch (err: any) {
          logger.warn('Insert failed', { table: tableName, error: err.message, signature });
        }
      }

      // Update checkpoint inside same transaction
      if (slot > this.getLastProcessedSlot()) {
        this.setLastProcessedSlot(slot);
      }
    });

    insertFn();
  }

  /**
   * Decode and store on-chain account state for a given account type.
   */
  async indexAccountState(pubkey: string, accountTypeName: string): Promise<void> {
    const accDef = this.idl.accounts?.find(a => a.name === accountTypeName);
    if (!accDef) throw new Error(`Account type '${accountTypeName}' not in IDL`);

    const accountInfo = await this.fetchAccountInfo(new PublicKey(pubkey));
    if (!accountInfo) {
      logger.warn('Account not found', { pubkey });
      return;
    }

    const tableName = getAccountTableName(this.idl.name, accDef.name);
    const data = Buffer.from(accountInfo.data);

    // Decode fields (skip 8-byte Anchor account discriminator)
    const row: Record<string, any> = { pubkey, slot: 0, updated_at: Date.now() };
    let offset = 8;
    for (const field of accDef.type.fields) {
      try {
        const { decodeField } = await import('./idl');
        const [val, nextOffset] = decodeField(field.type, data, offset);
        row[field.name.toLowerCase()] = val !== null ? String(val) : null;
        offset = nextOffset;
      } catch {
        row[field.name.toLowerCase()] = null;
      }
    }

    const cols = Object.keys(row);
    this.db.prepare(
      `INSERT OR REPLACE INTO ${tableName} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).run(...cols.map(c => row[c]));

    logger.info('Account state indexed', { pubkey, type: accountTypeName });
  }

  // ─── Batch mode ──────────────────────────────────────────────────────────────

  async runBatch(opts: BatchOptions = {}): Promise<number> {
    logger.info('Starting batch indexing', opts);
    let processed = 0;

    if (opts.signatures?.length) {
      for (const sig of opts.signatures) {
        if (this.shutdownRequested) break;
        const tx = await this.fetchTx(sig);
        if (tx) { this.processTx(tx, sig); processed++; }
        await sleep(50);
      }
      logger.info('Batch complete (signatures)', { processed });
      return processed;
    }

    // Paginate: getSignaturesForAddress returns newest first
    let before: string | undefined;

    while (!this.shutdownRequested) {
      const page = await this.fetchSignatures({ before, limit: 100 });
      if (!page.length) break;

      for (const sigInfo of page) {
        if (this.shutdownRequested) break;

        // fromSlot check: signatures are newest-first, so stop when below fromSlot
        if (opts.fromSlot !== undefined && sigInfo.slot < opts.fromSlot) {
          logger.info('Reached fromSlot boundary', { slot: sigInfo.slot, fromSlot: opts.fromSlot });
          return processed;
        }
        // toSlot check: skip if above toSlot
        if (opts.toSlot !== undefined && sigInfo.slot > opts.toSlot) continue;

        const tx = await this.fetchTx(sigInfo.signature);
        if (tx) { this.processTx(tx, sigInfo.signature); processed++; }
        await sleep(50);
      }

      before = page[page.length - 1].signature;
      logger.info('Batch progress', { processed, lastSlot: page[page.length - 1].slot });
    }

    logger.info('Batch complete', { processed });
    return processed;
  }

  // ─── Real-time mode with cold start ──────────────────────────────────────────

  async runRealtime(): Promise<void> {
    this.running = true;
    logger.info('Starting real-time indexing');

    // Cold start: backfill from last checkpoint
    await this.backfill();

    logger.info('Cold start complete, entering real-time polling');
    while (this.running && !this.shutdownRequested) {
      try {
        await this.pollNew();
      } catch (err: any) {
        logger.error('Poll error', { error: err.message });
      }
      await sleep(config.POLL_INTERVAL_MS);
    }
  }

  /**
   * Backfill: fetch all signatures newer than last checkpoint, process oldest-first.
   */
  private async backfill(): Promise<void> {
    const lastSlot = this.getLastProcessedSlot();
    logger.info('Backfilling from checkpoint', { lastSlot });
    let backfilled = 0;

    // Collect all new sigs first, then process oldest-first
    const allNewSigs: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;

    while (!this.shutdownRequested) {
      const page = await this.fetchSignatures({ before, limit: 100 });
      if (!page.length) break;

      const newInPage = page.filter(s => s.slot > lastSlot);
      allNewSigs.push(...newInPage);

      // Stop paginating when we hit already-seen slots
      if (newInPage.length < page.length) break;
      before = page[page.length - 1].signature;
    }

    // Process oldest first (reverse: getSignaturesForAddress returns newest first)
    for (const sigInfo of allNewSigs.reverse()) {
      if (this.shutdownRequested) break;
      const tx = await this.fetchTx(sigInfo.signature);
      if (tx) { this.processTx(tx, sigInfo.signature); backfilled++; }
      await sleep(50);
    }

    logger.info('Backfill complete', { backfilled, nowAtSlot: this.getLastProcessedSlot() });
  }

  /**
   * Poll for transactions newer than our last checkpoint.
   */
  private async pollNew(): Promise<void> {
    const lastSlot = this.getLastProcessedSlot();
    const sigs = await this.fetchSignatures({ limit: 20 });

    for (const sigInfo of sigs.reverse()) { // process oldest first
      if (sigInfo.slot <= lastSlot) continue;
      const tx = await this.fetchTx(sigInfo.signature);
      if (tx) { this.processTx(tx, sigInfo.signature); }
    }
  }

  // ─── Shutdown ─────────────────────────────────────────────────────────────

  stop(): void {
    logger.info('Graceful shutdown requested');
    this.shutdownRequested = true;
    this.running = false;
  }

  get isRunning() { return this.running; }
}
