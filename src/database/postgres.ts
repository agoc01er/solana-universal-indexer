/**
 * PostgreSQL adapter — optional production database backend.
 *
 * Usage: set DB_TYPE=postgres and DATABASE_URL=postgresql://...
 * Default is SQLite (zero-dependency, great for dev/testing).
 *
 * The adapter interface is identical to the SQLite path,
 * so switching is a single env var change.
 */
import { logger } from '../observability/logger';
import { AnchorIdl, generateSchemaSQL, getInstructionTableName, getAccountTableName } from '../idl/parser';

export interface PgConfig {
  connectionString: string;
  idl: AnchorIdl;
}

/**
 * Convert SQLite DDL to PostgreSQL DDL.
 * Main differences: INTEGER PRIMARY KEY → SERIAL, TEXT → TEXT (same), UNIQUE index syntax.
 */
function toPostgresDDL(sqliteDDL: string): string {
  return sqliteDDL
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
    .replace(/INSERT OR IGNORE INTO/g, 'INSERT INTO')
    .replace(/INSERT OR REPLACE INTO/g, 'INSERT INTO')
    .replace(/CREATE INDEX IF NOT EXISTS/g, 'CREATE INDEX IF NOT EXISTS')
    .replace(/\bINTEGER\b(?!\s+PRIMARY)/g, 'BIGINT')
    .replace(/journal_mode\s*=\s*WAL/gi, '')
    .replace(/synchronous\s*=\s*NORMAL/gi, '');
}

export class PostgresRepository {
  private pool: any = null;
  private idl: AnchorIdl;
  private ready = false;

  constructor(config: PgConfig) {
    this.idl = config.idl;
    try {
      const { Pool } = require('pg');
      this.pool = new Pool({ connectionString: config.connectionString });
      logger.info('PostgreSQL pool created');
    } catch {
      logger.error('pg package not found. Install with: npm install pg @types/pg');
      throw new Error('PostgreSQL requires "pg" package');
    }
  }

  async init(): Promise<void> {
    const sqliteDDL = generateSchemaSQL(this.idl);
    const pgDDL = toPostgresDDL(sqliteDDL);

    // Also create events table
    const eventsTable = `
      CREATE TABLE IF NOT EXISTS "${this.idl.name}_events" (
        id SERIAL PRIMARY KEY,
        event_name TEXT NOT NULL,
        signature TEXT NOT NULL,
        slot BIGINT NOT NULL,
        block_time BIGINT,
        data JSONB NOT NULL,
        indexed_at BIGINT NOT NULL,
        UNIQUE(signature, event_name)
      );
      CREATE INDEX IF NOT EXISTS "idx_${this.idl.name}_events_slot"
        ON "${this.idl.name}_events"(slot);
    `;

    await this.pool.query(pgDDL + eventsTable);
    this.ready = true;
    logger.info('PostgreSQL schema initialized', { program: this.idl.name });
  }

  // ── State ──────────────────────────────────────────────────────────────────

  async getState(key: string): Promise<string | null> {
    const res = await this.pool.query('SELECT value FROM _indexer_state WHERE key = $1', [key]);
    return res.rows[0]?.value ?? null;
  }

  async setState(key: string, value: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO _indexer_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, value]
    );
  }

  async getLastProcessedSlot(): Promise<number> {
    const val = await this.getState('last_processed_slot');
    return val ? parseInt(val) : 0;
  }

  async setLastProcessedSlot(slot: number): Promise<void> {
    await this.setState('last_processed_slot', String(slot));
  }

  // ── Instruction insert ────────────────────────────────────────────────────

  async insertInstruction(
    instructionName: string,
    signature: string,
    slot: number,
    blockTime: number | null,
    accounts: Record<string, string>,
    args: Record<string, any>,
    meta: { cpiDepth: number; parentIxIndex: number | null }
  ): Promise<void> {
    const tableName = getInstructionTableName(this.idl.name, instructionName);
    const row: Record<string, any> = {
      signature, slot, block_time: blockTime,
      cpi_depth: meta.cpiDepth,
      parent_ix_index: meta.parentIxIndex,
      indexed_at: Date.now(),
    };

    for (const [k, v] of Object.entries(accounts)) {
      row[`account_${k.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`] = v ?? null;
    }
    for (const [k, v] of Object.entries(args)) {
      row[`arg_${k.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`] =
        v !== null && v !== undefined ? String(v) : null;
    }

    const cols = Object.keys(row);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

    await this.pool.query(
      `INSERT INTO "${tableName}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      cols.map(c => row[c])
    );
  }

  // ── Event insert ──────────────────────────────────────────────────────────

  async insertEvent(
    eventName: string,
    signature: string,
    slot: number,
    blockTime: number | null,
    data: Record<string, any>
  ): Promise<void> {
    const tableName = `${this.idl.name}_events`;
    await this.pool.query(
      `INSERT INTO "${tableName}" (event_name, signature, slot, block_time, data, indexed_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [eventName, signature, slot, blockTime, JSON.stringify(data), Date.now()]
    );
  }

  // ── Account snapshot ──────────────────────────────────────────────────────

  async upsertAccountSnapshot(
    accountTypeName: string,
    pubkey: string,
    slot: number,
    data: Record<string, any>
  ): Promise<void> {
    const tableName = getAccountTableName(this.idl.name, accountTypeName);
    const row: Record<string, any> = { pubkey, slot, updated_at: Date.now() };
    for (const [k, v] of Object.entries(data)) {
      row[k.toLowerCase().replace(/[^a-z0-9_]/g, '_')] = v !== null ? String(v) : null;
    }
    const cols = Object.keys(row);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const updates = cols.filter(c => c !== 'pubkey').map((c, i) => `"${c}" = $${cols.indexOf(c) + 1}`).join(', ');

    await this.pool.query(
      `INSERT INTO "${tableName}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})
       ON CONFLICT (pubkey) DO UPDATE SET ${updates}`,
      cols.map(c => row[c])
    );
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  async queryInstructions(
    instructionName: string,
    filters: Record<string, any>,
    opts: { limit?: number; cursor?: string } = {}
  ): Promise<{ rows: any[]; total: number; nextCursor: string | null }> {
    const tableName = getInstructionTableName(this.idl.name, instructionName);
    const SAFE_COL = /^[a-z_][a-z0-9_]*$/;
    const limit = Math.min(opts.limit ?? 50, 200);

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (filters.slot_from) { conditions.push(`slot >= $${paramIdx++}`); params.push(filters.slot_from); }
    if (filters.slot_to) { conditions.push(`slot <= $${paramIdx++}`); params.push(filters.slot_to); }

    for (const [key, val] of Object.entries(filters)) {
      if (['slot_from', 'slot_to', 'cursor', 'limit'].includes(key)) continue;
      if (!SAFE_COL.test(key)) continue;
      conditions.push(`"${key}" = $${paramIdx++}`);
      params.push(val);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await this.pool.query(`SELECT COUNT(*) as cnt FROM "${tableName}" ${where}`, params);
    const total = parseInt(countRes.rows[0]?.cnt ?? '0');

    const rows = await this.pool.query(
      `SELECT * FROM "${tableName}" ${where} ORDER BY slot DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      [...params, limit, 0]
    );

    return { rows: rows.rows, total, nextCursor: null };
  }

  async getProgramStats(): Promise<Record<string, any>> {
    const stats: Record<string, any> = { program: this.idl.name, instructions: {}, events: {} };
    for (const ix of this.idl.instructions) {
      const tableName = getInstructionTableName(this.idl.name, ix.name);
      try {
        const res = await this.pool.query(`SELECT COUNT(*) as total, MIN(slot) as first_slot, MAX(slot) as last_slot FROM "${tableName}"`);
        stats.instructions[ix.name] = res.rows[0];
      } catch { stats.instructions[ix.name] = { total: 0 }; }
    }
    return stats;
  }

  async close(): Promise<void> {
    await this.pool.end();
    logger.info('PostgreSQL pool closed');
  }
}
