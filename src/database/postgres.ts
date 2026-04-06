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

  // ── Query with cursor-based pagination ────────────────────────────────────

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

    // Cursor-based pagination: WHERE (slot, id) > (cursorSlot, cursorId)
    const cursor = opts.cursor ? this.decodeCursor(opts.cursor) : null;
    if (cursor) {
      conditions.push(`(slot > $${paramIdx} OR (slot = $${paramIdx + 1} AND id > $${paramIdx + 2}))`);
      params.push(cursor.slot, cursor.slot, cursor.id);
      paramIdx += 3;
    }

    if (filters.slot_from) { conditions.push(`slot >= $${paramIdx++}`); params.push(filters.slot_from); }
    if (filters.slot_to) { conditions.push(`slot <= $${paramIdx++}`); params.push(filters.slot_to); }

    for (const [key, val] of Object.entries(filters)) {
      if (['slot_from', 'slot_to', 'cursor', 'limit'].includes(key)) continue;
      if (!SAFE_COL.test(key)) continue;
      conditions.push(`"${key}" = $${paramIdx++}`);
      params.push(val);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count without cursor condition for accurate total
    const countConditions = conditions.slice(cursor ? 1 : 0);
    const countParams = params.slice(cursor ? 3 : 0);
    const countWhere = countConditions.length ? `WHERE ${countConditions.join(' AND ')}` : '';
    const countRes = await this.pool.query(`SELECT COUNT(*) as cnt FROM "${tableName}" ${countWhere}`, countParams);
    const total = parseInt(countRes.rows[0]?.cnt ?? '0');

    const rows = await this.pool.query(
      `SELECT * FROM "${tableName}" ${where} ORDER BY slot ASC, id ASC LIMIT $${paramIdx}`,
      [...params, limit + 1]
    );

    const hasMore = rows.rows.length > limit;
    const data = rows.rows.slice(0, limit);
    const lastRow = data[data.length - 1];

    return {
      rows: data,
      total,
      nextCursor: hasMore && lastRow ? this.encodeCursor(lastRow.slot, lastRow.id) : null,
    };
  }

  // ── Events query ──────────────────────────────────────────────────────────

  async queryEvents(
    eventName?: string,
    filters: Record<string, any> = {},
    opts: { limit?: number; cursor?: string } = {}
  ): Promise<{ rows: any[]; total: number; nextCursor: string | null }> {
    const tableName = `${this.idl.name}_events`;
    const limit = Math.min(opts.limit ?? 50, 200);
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (eventName) { conditions.push(`event_name = $${paramIdx++}`); params.push(eventName); }
    if (filters.slot_from) { conditions.push(`slot >= $${paramIdx++}`); params.push(filters.slot_from); }
    if (filters.slot_to) { conditions.push(`slot <= $${paramIdx++}`); params.push(filters.slot_to); }

    const cursor = opts.cursor ? this.decodeCursor(opts.cursor) : null;
    if (cursor) {
      conditions.push(`(slot > $${paramIdx} OR (slot = $${paramIdx + 1} AND id > $${paramIdx + 2}))`);
      params.push(cursor.slot, cursor.slot, cursor.id);
      paramIdx += 3;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.pool.query(
      `SELECT * FROM "${tableName}" ${where} ORDER BY slot ASC, id ASC LIMIT $${paramIdx}`,
      [...params, limit + 1]
    );

    const hasMore = rows.rows.length > limit;
    const data = rows.rows.slice(0, limit);
    const lastRow = data[data.length - 1];

    return {
      rows: data,
      total: data.length,
      nextCursor: hasMore && lastRow ? this.encodeCursor(lastRow.slot, lastRow.id) : null,
    };
  }

  // ── Aggregation (extended) ────────────────────────────────────────────────

  async aggregate(
    instructionName: string,
    groupBy: 'hour' | 'day' | 'total',
    slotFrom?: number,
    slotTo?: number,
    op: 'count' | 'sum' | 'avg' | 'min' | 'max' = 'count',
    field?: string
  ): Promise<any[]> {
    const tableName = getInstructionTableName(this.idl.name, instructionName);
    const SAFE_COL = /^[a-z_][a-z0-9_]*$/;
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (slotFrom) { conditions.push(`slot >= $${paramIdx++}`); params.push(slotFrom); }
    if (slotTo) { conditions.push(`slot <= $${paramIdx++}`); params.push(slotTo); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    let aggExpr = 'COUNT(*)';
    if (op !== 'count' && field) {
      if (!SAFE_COL.test(field)) throw new Error(`Unsafe field name: ${field}`);
      aggExpr = `${op.toUpperCase()}(CAST("${field}" AS NUMERIC))`;
    }

    if (groupBy === 'hour') {
      const res = await this.pool.query(
        `SELECT COALESCE(block_time / 3600, slot / 9000) as bucket, ${aggExpr} as value, COUNT(*) as count FROM "${tableName}" ${where} GROUP BY bucket ORDER BY bucket DESC LIMIT 168`,
        params
      );
      return res.rows;
    }
    if (groupBy === 'day') {
      const res = await this.pool.query(
        `SELECT COALESCE(block_time / 86400, slot / 216000) as bucket, ${aggExpr} as value, COUNT(*) as count FROM "${tableName}" ${where} GROUP BY bucket ORDER BY bucket DESC LIMIT 30`,
        params
      );
      return res.rows;
    }
    const res = await this.pool.query(
      `SELECT ${aggExpr} as value, COUNT(*) as total_calls, MIN(slot) as first_slot, MAX(slot) as last_slot FROM "${tableName}" ${where}`,
      params
    );
    return res.rows;
  }

  // ── Account history (append-only) ─────────────────────────────────────────

  async insertAccountHistory(
    accountTypeName: string,
    pubkey: string,
    slot: number,
    data: Record<string, any>
  ): Promise<void> {
    const tableName = `acc_history_${this.idl.name}_${accountTypeName}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');

    const cols = Object.keys(data).map(k => `"${k.toLowerCase().replace(/[^a-z0-9_]/g, '_')}" TEXT`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "${tableName}" (
        id SERIAL PRIMARY KEY,
        pubkey TEXT NOT NULL,
        slot BIGINT NOT NULL,
        ${cols.join(',\n        ')},
        recorded_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idx_${tableName}_pubkey" ON "${tableName}"(pubkey, slot DESC);
    `);

    const row: Record<string, any> = { pubkey, slot, recorded_at: Date.now() };
    for (const [k, v] of Object.entries(data)) {
      row[k.toLowerCase().replace(/[^a-z0-9_]/g, '_')] = v !== null ? String(v) : null;
    }
    const rowCols = Object.keys(row);
    const placeholders = rowCols.map((_, i) => `$${i + 1}`).join(', ');
    await this.pool.query(
      `INSERT INTO "${tableName}" (${rowCols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`,
      rowCols.map(c => row[c])
    );
  }

  async queryAccountHistory(
    accountTypeName: string,
    pubkey: string,
    opts: { limit?: number; offset?: number } = {}
  ): Promise<any[]> {
    const tableName = `acc_history_${this.idl.name}_${accountTypeName}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;
    try {
      const res = await this.pool.query(
        `SELECT * FROM "${tableName}" WHERE pubkey = $1 ORDER BY slot DESC LIMIT $2 OFFSET $3`,
        [pubkey, limit, offset]
      );
      return res.rows;
    } catch {
      return [];
    }
  }

  // ── Readiness check ───────────────────────────────────────────────────────

  isReady(): boolean {
    return this.ready;
  }

  // ── Program stats ─────────────────────────────────────────────────────────

  async getProgramStats(): Promise<Record<string, any>> {
    const stats: Record<string, any> = { program: this.idl.name, instructions: {}, events: {} };
    for (const ix of this.idl.instructions) {
      const tableName = getInstructionTableName(this.idl.name, ix.name);
      try {
        const res = await this.pool.query(`SELECT COUNT(*) as total, MIN(slot) as first_slot, MAX(slot) as last_slot FROM "${tableName}"`);
        stats.instructions[ix.name] = res.rows[0];
      } catch { stats.instructions[ix.name] = { total: 0 }; }
    }

    try {
      const eventsTable = `${this.idl.name}_events`;
      const res = await this.pool.query(`SELECT event_name, COUNT(*) as count FROM "${eventsTable}" GROUP BY event_name`);
      for (const row of res.rows) stats.events[row.event_name] = parseInt(row.count);
    } catch { /* no events */ }

    return stats;
  }

  // ── Cursor helpers ────────────────────────────────────────────────────────

  private encodeCursor(slot: number, id: number): string {
    return Buffer.from(JSON.stringify({ slot, id })).toString('base64url');
  }

  private decodeCursor(cursor: string): { slot: number; id: number } | null {
    try {
      return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    logger.info('PostgreSQL pool closed');
  }
}
