import Database from 'better-sqlite3';
import { SolanaIndexer } from './indexer';
import { createApp } from './api';
import { config } from './config';
import { logger } from './logger';
import { AnchorIdl } from './idl';
import * as fs from 'fs';
import * as path from 'path';

function loadIdl(): AnchorIdl {
  const idlPath = process.env.IDL_PATH ?? './idl.json';
  if (!fs.existsSync(idlPath)) {
    // Use a default example IDL if none provided
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
          args: [
            { name: 'amount', type: 'u64' },
          ],
        },
        {
          name: 'initialize',
          accounts: [
            { name: 'authority', isMut: false, isSigner: true },
            { name: 'state', isMut: true, isSigner: false },
          ],
          args: [],
        },
      ],
      accounts: [],
    };
  }
  return JSON.parse(fs.readFileSync(idlPath, 'utf8'));
}

async function main() {
  logger.info('Starting Universal Solana Indexer');

  const idl = loadIdl();
  logger.info('Loaded IDL', { program: idl.name, instructions: idl.instructions.length });

  const db = new Database(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  const programId = process.env.PROGRAM_ID ?? config.PROGRAM_ID;
  if (!programId) {
    logger.error('PROGRAM_ID environment variable is required');
    process.exit(1);
  }

  const indexer = new SolanaIndexer({ idl, programId, db });
  const app = createApp(db, indexer, idl);

  const server = app.listen(config.PORT, () => {
    logger.info('API server started', { port: config.PORT });
  });

  // Start indexing based on MODE env var
  const mode = (process.env.MODE ?? 'realtime') as 'realtime' | 'batch';

  if (mode === 'batch') {
    const fromSlot = process.env.FROM_SLOT ? parseInt(process.env.FROM_SLOT) : undefined;
    const toSlot = process.env.TO_SLOT ? parseInt(process.env.TO_SLOT) : undefined;
    await indexer.runBatch({ fromSlot, toSlot });
    logger.info('Batch indexing complete, shutting down');
    server.close();
    db.close();
    process.exit(0);
  } else {
    indexer.runRealtime().catch(err => {
      logger.error('Indexer crashed', { error: err.message });
      process.exit(1);
    });
  }

  // Graceful shutdown
  async function shutdown(signal: string) {
    logger.info('Received shutdown signal', { signal });
    indexer.stop();
    server.close(() => {
      logger.info('HTTP server closed');
      db.close();
      logger.info('Database closed');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
