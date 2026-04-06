import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Solana RPC
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  WS_URL: process.env.WS_URL || '',

  // Program
  PROGRAM_ID: process.env.PROGRAM_ID || '',
  IDL_PATH: process.env.IDL_PATH || './idl.json',

  // API
  PORT: parseInt(process.env.PORT || '3000'),

  // Database: postgres (production default) or sqlite (edge/CI/lightweight)
  DB_TYPE: (process.env.DB_TYPE || 'postgres') as 'sqlite' | 'postgres',
  DB_PATH: process.env.DB_PATH || './indexer.db',
  DATABASE_URL: process.env.DATABASE_URL || '',

  // Indexer behavior
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '5000'),
  MODE: (process.env.MODE || 'realtime') as 'realtime' | 'batch' | 'backfill_then_realtime',
  FROM_SLOT: process.env.FROM_SLOT ? parseInt(process.env.FROM_SLOT) : undefined,
  TO_SLOT: process.env.TO_SLOT ? parseInt(process.env.TO_SLOT) : undefined,

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

// ── Config validation ─────────────────────────────────────────────────────────

export function validateConfig(): void {
  const errors: string[] = [];

  if (!config.PROGRAM_ID) errors.push('PROGRAM_ID is required');
  if (config.DB_TYPE === 'postgres' && !config.DATABASE_URL) {
    errors.push('DATABASE_URL is required when DB_TYPE=postgres');
  }
  if (!['realtime', 'batch', 'backfill_then_realtime'].includes(config.MODE)) {
    errors.push(`Invalid MODE: ${config.MODE}. Use: realtime, batch, or backfill_then_realtime`);
  }
  if (config.MODE === 'batch' && !config.FROM_SLOT && !config.TO_SLOT) {
    errors.push('FROM_SLOT or TO_SLOT is required in batch mode');
  }
  if (config.PORT < 1 || config.PORT > 65535) {
    errors.push(`Invalid PORT: ${config.PORT}`);
  }

  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`[CONFIG ERROR] ${err}`);
    }
    throw new Error(`Configuration invalid: ${errors.join('; ')}`);
  }
}
