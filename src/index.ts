import * as fs from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorIdl } from './idl/parser';
import { createDb } from './database/sqlite';
import { SolanaIndexer } from './indexer/indexer';
import { createApp } from './api/routes';
import { AccountWatcher } from './indexer/account-watcher';
import { IdlVersionManager } from './database/migrations';
import { config, validateConfig } from './config';
import { logger } from './observability/logger';

async function loadIdl(): Promise<AnchorIdl> {
  // 1. Try on-chain IDL if IDL_ACCOUNT is set
  if (config.IDL_ACCOUNT) {
    logger.info('Fetching IDL from on-chain account', { account: config.IDL_ACCOUNT });
    const connection = new Connection(config.RPC_URL);
    const onChainIdl = await IdlVersionManager.fetchFromChain(config.IDL_ACCOUNT, connection);
    if (onChainIdl) {
      logger.info('On-chain IDL loaded', { program: onChainIdl.name, instructions: onChainIdl.instructions.length });
      return onChainIdl;
    }
    logger.warn('On-chain IDL fetch failed, falling back to file', { account: config.IDL_ACCOUNT });
  }

  // 2. Try IDL file
  const idlPath = config.IDL_PATH;
  if (!fs.existsSync(idlPath)) {
    logger.warn('No IDL file found, using built-in example IDL', { idlPath });
    return {
      name: 'example_program',
      version: '0.1.0',
      instructions: [
        {
          name: 'transfer',
          accounts: [
            { name: 'from', isMut: true, isSigner: true },
            { name: 'to', isMut: true, isSigner: false },
          ],
          args: [{ name: 'amount', type: 'u64' }],
        },
        {
          name: 'initialize',
          accounts: [{ name: 'authority', isMut: false, isSigner: true }],
          args: [{ name: 'bump', type: 'u8' }],
        },
      ],
      accounts: [],
    };
  }
  return JSON.parse(fs.readFileSync(idlPath, 'utf8'));
}

async function main() {
  logger.info('Starting Universal Solana Indexer', { version: '3.0.0' });

  // Validate configuration before anything else
  validateConfig();

  const idl = await loadIdl();
  logger.info('IDL loaded', {
    program: idl.name,
    instructions: idl.instructions.length,
    accounts: idl.accounts?.length ?? 0,
    events: (idl as any).events?.length ?? 0,
  });

  const programId = new PublicKey(config.PROGRAM_ID);

  // ── Database setup (SQLite default, PostgreSQL optional) ──────────────────
  let repo: any;

  if (config.DB_TYPE === 'postgres' && config.DATABASE_URL) {
    logger.info('Using PostgreSQL backend');
    const { PostgresRepository } = await import('./database/postgres');
    repo = new PostgresRepository({ connectionString: config.DATABASE_URL, idl });
    await repo.init();
  } else {
    logger.info('Using SQLite backend (lightweight mode — set DB_TYPE=postgres for production)');
    repo = createDb(idl, config.DB_PATH);
  }

  // ── IDL Version Manager ───────────────────────────────────────────────────
  let idlDb: any;
  try {
    const Database = require('better-sqlite3');
    idlDb = new Database(config.DB_PATH);
  } catch { idlDb = null; }

  if (idlDb) {
    const idlVersionManager = new IdlVersionManager(config.PROGRAM_ID, idlDb);
    idlVersionManager.registerIdl(idl);

    // Check for on-chain IDL upgrade
    try {
      const { Connection } = require('@solana/web3.js');
      const conn = new Connection(config.RPC_URL, 'confirmed');
      const onChainIdl = await IdlVersionManager.fetchFromChain(config.PROGRAM_ID, conn);
      if (onChainIdl) {
        logger.info('On-chain IDL found, checking for upgrade');
        await idlVersionManager.checkForUpgrade(onChainIdl, 0);
      }
    } catch (err: any) {
      logger.debug('On-chain IDL check skipped', { error: err.message });
    }
  }

  // ── Indexer setup ─────────────────────────────────────────────────────────
  const indexer = new SolanaIndexer(idl, programId, repo, config.RPC_URL);

  // ── Account Watcher (background daemon) ───────────────────────────────────
  let accountWatcher: AccountWatcher | null = null;
  if (idl.accounts?.length && config.MODE === 'realtime') {
    accountWatcher = new AccountWatcher(
      idl,
      programId,
      repo,
      config.RPC_URL,
      config.WS_URL,
      30_000
    );

    // Subscribe to real-time account changes
    await accountWatcher.subscribeToChanges();

    // Start background sync loop (non-blocking)
    accountWatcher.start().catch(err => {
      logger.error('Account watcher crashed', { error: err.message });
    });
  }

  // ── API server ────────────────────────────────────────────────────────────
  const app = createApp(repo, indexer, idl, config.PROGRAM_ID);
  const server = app.listen(config.PORT, () => {
    logger.info('API server ready', {
      port: config.PORT,
      endpoints: {
        health: `/health`,
        ready: `/ready`,
        metrics: `/metrics`,
        schema: `/schema`,
        stats: `/stats`,
        events: `/events`,
        instructions: `/instructions/:name`,
        accountHistory: `/accounts/:type/:pubkey/history`,
      },
    });
  });

  // ── Start indexing ────────────────────────────────────────────────────────
  if (config.MODE === 'batch') {
    logger.info('Starting batch mode', { fromSlot: config.FROM_SLOT, toSlot: config.TO_SLOT });
    await indexer.runBatch({ fromSlot: config.FROM_SLOT, toSlot: config.TO_SLOT });
    logger.info('Batch complete');
    server.close();
    process.exit(0);
  } else if (config.MODE === 'backfill_then_realtime') {
    // Cold start: backfill from FROM_SLOT to chain tip, then switch to realtime
    logger.info('Starting backfill_then_realtime mode', { fromSlot: config.FROM_SLOT });
    const fromSlot = config.FROM_SLOT ?? repo.getLastProcessedSlot();
    if (fromSlot > 0) {
      logger.info('Backfilling from slot', { fromSlot });
      await indexer.runBatch({ fromSlot });
      logger.info('Backfill complete, switching to realtime');
    }
    indexer.runRealtime().catch(err => {
      logger.error('Indexer fatal error', { error: err.message });
      process.exit(1);
    });
  } else {
    indexer.runRealtime().catch(err => {
      logger.error('Indexer fatal error', { error: err.message });
      process.exit(1);
    });
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info('Shutdown signal', { signal });

    accountWatcher?.stop();
    await indexer.stop();

    server.close(async () => {
      logger.info('HTTP server closed');
      if (repo.close) await repo.close();
      logger.info('Shutdown complete');
      process.exit(0);
    });

    setTimeout(() => { logger.error('Forced exit'); process.exit(1); }, 10_000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
