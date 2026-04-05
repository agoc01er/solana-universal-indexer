import Database from 'better-sqlite3';
import { SchemaManager } from './schema';
import { SolanaIndexer } from './indexer';
import { createApp } from './api';
import { config } from './config';

async function main() {
  console.log('Starting Universal Solana Indexer...');

  const db = new Database(config.DB_PATH);
  const schemaManager = new SchemaManager(db);
  const indexer = new SolanaIndexer(schemaManager);
  const app = createApp(schemaManager, indexer);

  indexer.startAll();

  app.listen(config.PORT, () => {
    console.log(`API server running on http://localhost:${config.PORT}`);
    console.log(`Health check: http://localhost:${config.PORT}/health`);
  });

  process.on('SIGINT', () => {
    indexer.stop();
    db.close();
    process.exit(0);
  });
}

main().catch(console.error);
