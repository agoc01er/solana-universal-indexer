import * as fs from 'fs';
import { PublicKey } from '@solana/web3.js';
import { AnchorIdl } from './idl';
import { createDb } from './db';
import { SolanaIndexer } from './indexer';
import { createApp } from './api';
import { IdlVersionManager } from './idl-version';
import { config } from './config';
import { logger } from './logger';

function loadIdl(): AnchorIdl {
  const idlPath = config.IDL_PATH;
  if (!fs.existsSync(idlPath)) {
    logger.warn('No IDL file found, using example IDL', { idlPath });
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
          args: [],
        },
      ],
      accounts: [],
    };
  }
  return JSON.parse(fs.readFileSync(idlPath, 'utf8'));
}

async function main() {
  logger.info('Starting Universal Solana Indexer v2');

  if (!config.PROGRAM_ID) {
    logger.error('PROGRAM_ID is required');
    process.exit(1);
  }

  const idl = loadIdl();
  logger.info('IDL loaded', { program: idl.name, instructions: idl.instructions.length });

  const programId = new PublicKey(config.PROGRAM_ID);

  // Create DB
  const repo = createDb(idl, config.DB_PATH);

  // IDL version tracking
  const idlVersionManager = new IdlVersionManager(config.PROGRAM_ID, (repo as any).db ?? (() => {
    // Access the underlying SQLite db — quick workaround
    const Database = require('better-sqlite3');
    return new Database(config.DB_PATH);
  })());
  idlVersionManager.registerIdl(idl);

  // Also try to fetch IDL from on-chain
  try {
    const { Connection } = require('@solana/web3.js');
    const conn = new Connection(config.RPC_URL, 'confirmed');
    const onChainIdl = await IdlVersionManager.fetchFromChain(config.PROGRAM_ID, conn);
    if (onChainIdl) {
      logger.info('On-chain IDL found, checking for upgrade');
      await idlVersionManager.checkForUpgrade(onChainIdl, 0);
    }
  } catch (err: any) {
    logger.debug('Could not check on-chain IDL', { error: err.message });
  }

  const indexer = new SolanaIndexer(idl, programId, repo, config.RPC_URL);
  const app = createApp(repo, indexer, idl);

  const server = app.listen(config.PORT, () => {
    logger.info('API server started', { port: config.PORT });
    logger.info('Endpoints available', {
      health: `http://localhost:${config.PORT}/health`,
      metrics: `http://localhost:${config.PORT}/metrics`,
      schema: `http://localhost:${config.PORT}/schema`,
      stats: `http://localhost:${config.PORT}/stats`,
      events: `http://localhost:${config.PORT}/events`,
    });
  });

  // Start indexing
  if (config.MODE === 'batch') {
    await indexer.runBatch({ fromSlot: config.FROM_SLOT, toSlot: config.TO_SLOT });
    logger.info('Batch complete, shutting down');
    server.close();
    process.exit(0);
  } else {
    indexer.runRealtime().catch(err => {
      logger.error('Indexer fatal error', { error: err.message });
      process.exit(1);
    });
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info('Shutdown signal received', { signal });
    await indexer.stop();
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
    setTimeout(() => { logger.error('Forced exit'); process.exit(1); }, 10000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
