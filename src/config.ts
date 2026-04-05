import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  WS_URL: process.env.WS_URL || '',
  PORT: parseInt(process.env.PORT || '3000'),
  DB_PATH: process.env.DB_PATH || './indexer.db',
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '5000'),
  PROGRAM_ID: process.env.PROGRAM_ID || '',
  IDL_PATH: process.env.IDL_PATH || './idl.json',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  MODE: (process.env.MODE || 'realtime') as 'realtime' | 'batch',
  FROM_SLOT: process.env.FROM_SLOT ? parseInt(process.env.FROM_SLOT) : undefined,
  TO_SLOT: process.env.TO_SLOT ? parseInt(process.env.TO_SLOT) : undefined,
};
