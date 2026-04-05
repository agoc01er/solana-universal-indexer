/**
 * Account State Watcher
 *
 * Runs as a background daemon that:
 * 1. Fetches all program-owned accounts via getProgramAccounts on startup
 * 2. Decodes each account using BorshAccountsCoder against the IDL
 * 3. Subscribes to account changes via WebSocket (accountSubscribe)
 * 4. Re-syncs periodically to catch any missed updates
 *
 * Approach differs from competitors: we use both getProgramAccounts (bulk)
 * AND per-account WebSocket subscriptions (real-time) for completeness.
 */
import { Connection, PublicKey, KeyedAccountInfo, Context } from '@solana/web3.js';
import { AnchorIdl } from './idl';
import { AccountDecoder } from './decoder';
import { IndexerRepository } from './db';
import { withRetry, sleep } from './retry';
import { logger } from './logger';
import { metrics } from './metrics';

export class AccountWatcher {
  private connection: Connection;
  private decoder: AccountDecoder;
  private subscriptionIds: number[] = [];
  private running = false;
  private syncIntervalMs: number;

  constructor(
    private idl: AnchorIdl,
    private programId: PublicKey,
    private repo: IndexerRepository,
    rpcUrl: string,
    private wsUrl: string,
    syncIntervalMs = 30_000
  ) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.decoder = new AccountDecoder(idl);
    this.syncIntervalMs = syncIntervalMs;
  }

  /**
   * Start: bulk sync on startup, then watch for changes.
   */
  async start(): Promise<void> {
    if (!this.idl.accounts?.length) {
      logger.info('No account types in IDL, skipping account watcher');
      return;
    }
    this.running = true;
    logger.info('Account watcher starting', {
      program: this.idl.name,
      accountTypes: this.idl.accounts.map(a => a.name),
    });

    // Initial bulk sync
    await this.syncAll();

    // Periodic re-sync loop (catches missed changes)
    while (this.running) {
      await sleep(this.syncIntervalMs);
      if (!this.running) break;
      await this.syncAll();
    }
  }

  /**
   * Bulk fetch all program accounts and decode them.
   * Uses getProgramAccounts with memcmp filters per account type
   * (discriminator-based filtering for efficiency).
   */
  async syncAll(): Promise<number> {
    let total = 0;
    const slot = await this.getSlot();

    for (const accDef of (this.idl.accounts ?? [])) {
      try {
        const count = await this.syncAccountType(accDef.name, slot);
        total += count;
      } catch (err: any) {
        logger.error('Account sync failed', { type: accDef.name, error: err.message });
      }
    }

    logger.info('Account state sync complete', { total, slot });
    return total;
  }

  private async syncAccountType(accountTypeName: string, slot: number): Promise<number> {
    // Get discriminator for this account type
    const { computeDiscriminator } = await import('./idl');
    // Anchor account discriminator: sha256("account:<AccountName>")[0..8]
    const crypto = require('crypto');
    const disc = crypto.createHash('sha256')
      .update(`account:${accountTypeName}`)
      .digest()
      .slice(0, 8) as Buffer;

    const accounts = await withRetry(
      () => this.connection.getProgramAccounts(this.programId, {
        filters: [
          { memcmp: { offset: 0, bytes: disc.toString('base64') } },
        ],
      }),
      { maxAttempts: 3, initialDelayMs: 1000 }
    );

    let decoded = 0;
    for (const { pubkey, account } of accounts) {
      const data = Buffer.from(account.data);
      const result = this.decoder.decode(accountTypeName, data);
      if (!result) continue;

      this.repo.upsertAccountSnapshot(accountTypeName, pubkey.toString(), slot, result.data);
      decoded++;
    }

    if (decoded > 0) {
      logger.info('Account type synced', { type: accountTypeName, count: decoded });
      metrics.incrementCounter('indexer_accounts_synced_total', 'Accounts synced', { type: accountTypeName }, decoded);
    }

    return decoded;
  }

  private async getSlot(): Promise<number> {
    try {
      return await this.connection.getSlot('confirmed');
    } catch {
      return 0;
    }
  }

  /**
   * Subscribe to real-time account changes via WebSocket.
   * Fires whenever a program-owned account is modified.
   */
  async subscribeToChanges(): Promise<void> {
    if (!this.idl.accounts?.length) return;

    const wsConnection = new Connection(this.wsUrl || this.connection.rpcEndpoint, 'confirmed');

    try {
      const subId = wsConnection.onProgramAccountChange(
        this.programId,
        async (keyedAccountInfo: KeyedAccountInfo, context: Context) => {
          const { accountId, accountInfo } = keyedAccountInfo;
          const data = Buffer.from(accountInfo.data);

          // Try each account type
          for (const accDef of (this.idl.accounts ?? [])) {
            const result = this.decoder.decode(accDef.name, data);
            if (!result) continue;

            this.repo.upsertAccountSnapshot(
              accDef.name,
              accountId.toString(),
              context.slot,
              result.data
            );

            logger.debug('Account state updated via WS', {
              type: accDef.name,
              pubkey: accountId.toString(),
              slot: context.slot,
            });
            break;
          }
        },
        'confirmed'
      );

      this.subscriptionIds.push(subId);
      logger.info('Account change subscription active', { subscriptionId: subId });
    } catch (err: any) {
      logger.warn('Account WS subscription failed', { error: err.message });
    }
  }

  stop(): void {
    this.running = false;
    logger.info('Account watcher stopped');
  }
}
