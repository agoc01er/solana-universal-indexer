import {
  Connection,
  PublicKey,
  ConfirmedSignatureInfo,
  ParsedTransactionWithMeta,
  Logs,
} from '@solana/web3.js';
import { config } from './config';
import { logger } from './logger';
import { withRetry, sleep } from './retry';
import { AnchorIdl } from './idl';
import { InstructionDecoder, AccountDecoder } from './decoder';
import { EventDecoder } from './events';
import { IndexerRepository } from './db';
import {
  recordTxProcessed,
  recordTxLatency,
  recordRpcCall,
  recordRpcError,
  setLastProcessedSlot,
  setSlotLag,
  recordEventDecoded,
  recordInstructionIndexed,
} from './metrics';

export interface BatchOptions {
  fromSlot?: number;
  toSlot?: number;
  signatures?: string[];
}

export class SolanaIndexer {
  private connection: Connection;
  private wsConnection: Connection;
  private ixDecoder: InstructionDecoder;
  private accDecoder: AccountDecoder;
  private eventDecoder: EventDecoder;
  private running = false;
  private shutdownRequested = false;
  private wsSubscriptionId: number | null = null;
  // Gap detection: track slots seen via WS vs polling
  private wsSeenSlots = new Set<number>();
  private lastGapCheckSlot = 0;

  constructor(
    private idl: AnchorIdl,
    private programId: PublicKey,
    private repo: IndexerRepository,
    rpcUrl?: string
  ) {
    this.connection = new Connection(rpcUrl ?? config.RPC_URL, 'confirmed');
    const wsUrl = config.WS_URL ||
      (rpcUrl ?? config.RPC_URL)
        .replace('https://', 'wss://')
        .replace('http://', 'ws://');
    this.wsConnection = new Connection(wsUrl, 'confirmed');

    this.ixDecoder = new InstructionDecoder(idl);
    this.accDecoder = new AccountDecoder(idl);
    this.eventDecoder = new EventDecoder(idl);

    logger.info('Indexer initialized', {
      program: idl.name,
      programId: programId.toString(),
      instructions: idl.instructions.map(ix => ix.name),
      hasEvents: this.eventDecoder.hasEvents,
    });
  }

  // ─── RPC wrappers with metrics ────────────────────────────────────────────

  private async fetchTx(signature: string): Promise<ParsedTransactionWithMeta | null> {
    const start = Date.now();
    try {
      const result = await withRetry(
        () => this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        }),
        { maxAttempts: 5, initialDelayMs: 500, jitter: true }
      );
      recordRpcCall('getParsedTransaction', Date.now() - start);
      return result;
    } catch (err: any) {
      recordRpcError('getParsedTransaction');
      throw err;
    }
  }

  private async fetchSignatures(opts: { before?: string; limit?: number } = {}): Promise<ConfirmedSignatureInfo[]> {
    const start = Date.now();
    try {
      const result = await withRetry(
        () => this.connection.getSignaturesForAddress(
          this.programId,
          { before: opts.before, limit: opts.limit ?? 100 },
          'confirmed'
        ),
        { maxAttempts: 5, initialDelayMs: 500, jitter: true }
      );
      recordRpcCall('getSignaturesForAddress', Date.now() - start);
      return result;
    } catch (err: any) {
      recordRpcError('getSignaturesForAddress');
      throw err;
    }
  }

  private async getSlotHeight(): Promise<number> {
    try {
      return await this.connection.getSlot('finalized');
    } catch {
      return 0;
    }
  }

  // ─── Transaction processing ───────────────────────────────────────────────

  private processTx(tx: ParsedTransactionWithMeta, signature: string): void {
    const txStart = Date.now();
    if (!tx.meta || tx.meta.err) {
      recordTxProcessed(this.idl.name, 'skipped');
      return;
    }

    const slot = tx.slot;
    const blockTime = tx.blockTime ?? null;
    const message = tx.transaction.message as any;
    const instructions: any[] = message.instructions ?? [];
    const accountKeys: any[] = message.accountKeys ?? [];
    const accountKeyStrings = accountKeys.map((k: any) => k.pubkey?.toString() ?? '');
    const logs = tx.meta.logMessages ?? [];

    // ── Decode Anchor events from program logs ────────────────────────────────
    if (this.eventDecoder.hasEvents) {
      const events = this.eventDecoder.decodeFromLogs(logs, slot, signature);
      for (const event of events) {
        this.repo.insertEvent(event.name, signature, slot, blockTime, event.data);
        recordEventDecoded(event.name);
      }
    }

    // ── Decode top-level instructions ─────────────────────────────────────────
    for (const ix of instructions) {
      if (ix.programId?.toString() !== this.programId.toString()) continue;
      if (!ix.data) continue;

      const decoded = this.ixDecoder.decode(ix.data, accountKeyStrings);
      if (!decoded) continue;

      this.repo.insertInstruction(
        decoded.name, signature, slot, blockTime,
        decoded.accounts, decoded.args,
        { cpiDepth: 0, parentIxIndex: null }
      );
      recordInstructionIndexed(decoded.name);
    }

    // ── Decode inner instructions (CPI) ──────────────────────────────────────
    const innerIxs = tx.meta.innerInstructions ?? [];
    for (const inner of innerIxs) {
      for (const ix of inner.instructions as any[]) {
        if (ix.programId?.toString() !== this.programId.toString()) continue;
        if (!ix.data) continue;

        const decoded = this.ixDecoder.decode(ix.data, accountKeyStrings);
        if (!decoded) continue;

        this.repo.insertInstruction(
          decoded.name,
          `${signature}:cpi:${inner.index}`,
          slot, blockTime,
          decoded.accounts, decoded.args,
          { cpiDepth: 1, parentIxIndex: inner.index }
        );
        recordInstructionIndexed(decoded.name);
      }
    }

    if (slot > this.repo.getLastProcessedSlot()) {
      this.repo.setLastProcessedSlot(slot);
      setLastProcessedSlot(slot);
    }

    this.wsSeenSlots.add(slot);
    recordTxProcessed(this.idl.name, 'ok');
    recordTxLatency(Date.now() - txStart);
  }

  // ─── Account state indexing ───────────────────────────────────────────────

  async indexAllAccounts(): Promise<number> {
    if (!this.idl.accounts?.length) return 0;
    let count = 0;

    const programAccounts = await withRetry(
      () => this.connection.getProgramAccounts(this.programId),
      { maxAttempts: 3, initialDelayMs: 1000 }
    );

    for (const { pubkey, account } of programAccounts) {
      const data = Buffer.from(account.data);
      if (data.length < 8) continue;

      for (const accDef of (this.idl.accounts ?? [])) {
        const decoded = this.accDecoder.decode(accDef.name, data);
        if (!decoded) continue;
        this.repo.upsertAccountSnapshot(accDef.name, pubkey.toString(), 0, decoded.data);
        count++;
        break;
      }
    }

    logger.info('Account states indexed', { count });
    return count;
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
      logger.info('Batch complete', { processed });
      return processed;
    }

    let before: string | undefined;
    while (!this.shutdownRequested) {
      const page = await this.fetchSignatures({ before, limit: 100 });
      if (!page.length) break;

      for (const sigInfo of page) {
        if (this.shutdownRequested) break;
        if (opts.fromSlot !== undefined && sigInfo.slot < opts.fromSlot) {
          logger.info('Reached fromSlot boundary', { slot: sigInfo.slot });
          return processed;
        }
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

  // ─── Real-time with WebSocket + hybrid gap detection ──────────────────────

  async runRealtime(): Promise<void> {
    this.running = true;
    logger.info('Starting real-time indexing');

    await this.backfill();
    logger.info('Cold start complete');

    // Start WebSocket subscription
    await this.subscribeToLogs();

    // Hybrid: also poll periodically for gap detection
    let pollCycle = 0;
    while (this.running && !this.shutdownRequested) {
      await sleep(config.POLL_INTERVAL_MS);
      pollCycle++;

      // Every 6 cycles (~30s): run gap detection
      if (pollCycle % 6 === 0) {
        await this.detectAndFillGaps();
      }

      // Fallback poll if WS is down
      if (this.wsSubscriptionId === null) {
        try { await this.pollNew(); } catch (err: any) {
          logger.error('Fallback poll failed', { error: err.message });
        }
      }

      // Update slot lag metric every cycle
      try {
        const chainSlot = await this.getSlotHeight();
        const ourSlot = this.repo.getLastProcessedSlot();
        if (chainSlot > 0 && ourSlot > 0) setSlotLag(chainSlot - ourSlot);
      } catch { /* ignore */ }
    }
  }

  private async subscribeToLogs(): Promise<void> {
    try {
      this.wsSubscriptionId = this.wsConnection.onLogs(
        this.programId,
        async (logs: Logs) => {
          if (logs.err) return;
          try {
            const tx = await this.fetchTx(logs.signature);
            if (tx) this.processTx(tx, logs.signature);
          } catch (err: any) {
            logger.error('WS tx fetch failed', { sig: logs.signature, error: err.message });
          }
        },
        'confirmed'
      );
      logger.info('WebSocket subscription active', { id: this.wsSubscriptionId });
    } catch (err: any) {
      logger.warn('WebSocket failed, using polling only', { error: err.message });
      this.wsSubscriptionId = null;
    }
  }

  private async backfill(): Promise<void> {
    const lastSlot = this.repo.getLastProcessedSlot();
    logger.info('Backfilling', { fromSlot: lastSlot });

    const allNew: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;

    while (!this.shutdownRequested) {
      const page = await this.fetchSignatures({ before, limit: 100 });
      if (!page.length) break;
      const newInPage = page.filter(s => s.slot > lastSlot);
      allNew.push(...newInPage);
      if (newInPage.length < page.length) break;
      before = page[page.length - 1].signature;
    }

    for (const sigInfo of allNew.reverse()) {
      if (this.shutdownRequested) break;
      const tx = await this.fetchTx(sigInfo.signature);
      if (tx) this.processTx(tx, sigInfo.signature);
      await sleep(50);
    }

    logger.info('Backfill complete', { count: allNew.length, slot: this.repo.getLastProcessedSlot() });
  }

  private async pollNew(): Promise<void> {
    const lastSlot = this.repo.getLastProcessedSlot();
    const sigs = await this.fetchSignatures({ limit: 20 });
    for (const sigInfo of sigs.reverse()) {
      if (sigInfo.slot <= lastSlot) continue;
      const tx = await this.fetchTx(sigInfo.signature);
      if (tx) this.processTx(tx, sigInfo.signature);
    }
  }

  /**
   * Gap detection: compare WS-seen slots with recent polling results.
   * Fill any gaps to ensure completeness.
   */
  private async detectAndFillGaps(): Promise<void> {
    const lastSlot = this.repo.getLastProcessedSlot();
    if (lastSlot <= this.lastGapCheckSlot) return;

    try {
      const recentSigs = await this.fetchSignatures({ limit: 50 });
      const polledSlots = new Set(recentSigs.map(s => s.slot));

      let gapsFilled = 0;
      for (const sig of recentSigs) {
        if (!this.wsSeenSlots.has(sig.slot)) {
          // This slot was not seen via WebSocket — process it
          const tx = await this.fetchTx(sig.signature);
          if (tx) { this.processTx(tx, sig.signature); gapsFilled++; }
          await sleep(50);
        }
      }

      if (gapsFilled > 0) {
        logger.info('Gap detection filled missing txs', { gapsFilled });
      }

      this.lastGapCheckSlot = lastSlot;
      // Clean up old WS seen slots to prevent unbounded growth
      if (this.wsSeenSlots.size > 10000) {
        const minPolledSlot = Math.min(...polledSlots);
        for (const slot of this.wsSeenSlots) {
          if (slot < minPolledSlot - 1000) this.wsSeenSlots.delete(slot);
        }
      }
    } catch (err: any) {
      logger.warn('Gap detection error', { error: err.message });
    }
  }

  // ─── Shutdown ─────────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    logger.info('Graceful shutdown initiated');
    this.shutdownRequested = true;
    this.running = false;

    if (this.wsSubscriptionId !== null) {
      try {
        await this.wsConnection.removeOnLogsListener(this.wsSubscriptionId);
      } catch { /* ignore */ }
      this.wsSubscriptionId = null;
    }

    logger.info('Indexer stopped cleanly');
  }

  get isRunning() { return this.running; }
}
