/**
 * Database repository with SQL injection protection and cursor-based pagination.
 */
import { logger } from '../observability/logger';
import { AnchorIdl, generateSchemaSQL, getInstructionTableName, getAccountTableName } from '../idl/parser';

// Safe column name pattern — prevents SQL injection
const SAFE_COL = /^[a-z_][a-z0-9_]*$/;

function safeCol(name: string): string {
  if (!SAFE_COL.test(name)) throw new Error(`Unsafe column name: ${name}`);
  return `"${name}"`;
}

export interface QueryFilters {
  [key: string]: any;
  slot_from?: number;
  slot_to?: number;
}

export interface CursorPage {
  rows: any[];
  total: number;
  nextCursor: string | null;
}

function encodeCursor(slot: number, id: number): string {
  return Buffer.from(JSON.stringify({ slot, id })).toString('base64url');
}

function decodeCursor(cursor: string): { slot: number; id: number } | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export class IndexerRepository {
  constructor(private db: any, private idl: AnchorIdl) {
    const ddl = generateSchemaSQL(idl);
    db.exec(ddl);
    this.createEventTable();
    logger.info('Schema initialized', { program: idl.name });
  }

  private createEventTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "${this.idl.name}_events" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_name TEXT NOT NULL,
        signature TEXT NOT NULL,
        slot INTEGER NOT NULL,
        block_time INTEGER,
        data TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idx_${this.idl.name}_events_slot" ON "${this.idl.name}_events"(slot);
      CREATE INDEX IF NOT EXISTS "idx_${this.idl.name}_events_name" ON "${this.idl.name}_events"(event_name);
    `);
  }

  // ── State ──────────────────────────────────────────────────────────────────

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM _indexer_state WHERE key = ?').get(key) as any;
    return row?.value ?? null;
  }

  setState(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO _indexer_state (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  getLastProcessedSlot(): number {
    return parseInt(this.getState('last_processed_slot') ?? '0');
  }

  setLastProcessedSlot(slot: number) {
    this.setState('last_processed_slot', String(slot));
  }

  // ── Instruction insert with CPI metadata ──────────────────────────────────

  insertInstruction(
    instructionName: string,
    signature: string,
    slot: number,
    blockTime: number | null,
    accounts: Record<string, string>,
    args: Record<string, any>,
    meta: { cpiDepth: number; parentIxIndex: number | null }
  ) {
    const tableName = getInstructionTableName(this.idl.name, instructionName);
    const row: Record<string, any> = {
      signature,
      slot,
      block_time: blockTime,
      cpi_depth: meta.cpiDepth,
      parent_ix_index: meta.parentIxIndex,
      indexed_at: Date.now(),
    };

    for (const [k, v] of Object.entries(accounts)) {
      row[`account_${k.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`] = v ?? null;
    }
    for (const [k, v] of Object.entries(args)) {
      row[`arg_${k.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`] =
        v !== undefined && v !== null ? String(v) : null;
    }

    const cols = Object.keys(row);
    this.db.prepare(
      `INSERT OR IGNORE INTO "${tableName}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).run(...cols.map(c => row[c]));
  }

  // ── Anchor event insert ───────────────────────────────────────────────────

  insertEvent(
    eventName: string,
    signature: string,
    slot: number,
    blockTime: number | null,
    data: Record<string, any>
  ) {
    const tableName = `${this.idl.name}_events`;
    this.db.prepare(
      `INSERT OR IGNORE INTO "${tableName}" (event_name, signature, slot, block_time, data, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(eventName, signature, slot, blockTime, JSON.stringify(data), Date.now());
  }

  // ── Account snapshot ──────────────────────────────────────────────────────

  upsertAccountSnapshot(
    accountTypeName: string,
    pubkey: string,
    slot: number,
    data: Record<string, any>
  ) {
    const tableName = getAccountTableName(this.idl.name, accountTypeName);
    const row: Record<string, any> = { pubkey, slot, updated_at: Date.now() };
    for (const [k, v] of Object.entries(data)) {
      row[k.toLowerCase().replace(/[^a-z0-9_]/g, '_')] = v !== null ? String(v) : null;
    }
    const cols = Object.keys(row);
    this.db.prepare(
      `INSERT OR REPLACE INTO "${tableName}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).run(...cols.map(c => row[c]));
  }

  // ── Query with cursor-based pagination ────────────────────────────────────

  queryInstructions(
    instructionName: string,
    filters: QueryFilters,
    opts: { limit?: number; cursor?: string } = {}
  ): CursorPage {
    const tableName = getInstructionTableName(this.idl.name, instructionName);
    const limit = Math.min(opts.limit ?? 50, 200);

    const conditions: string[] = [];
    const params: any[] = [];

    // Cursor: WHERE (slot, id) > (cursorSlot, cursorId)
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    if (cursor) {
      conditions.push('(slot > ? OR (slot = ? AND id > ?))');
      params.push(cursor.slot, cursor.slot, cursor.id);
    }

    for (const [key, val] of Object.entries(filters)) {
      if (val === undefined || val === null) continue;
      if (key === 'slot_from') { conditions.push('slot >= ?'); params.push(val); continue; }
      if (key === 'slot_to') { conditions.push('slot <= ?'); params.push(val); continue; }
      if (!SAFE_COL.test(key)) continue; // SQL injection protection
      conditions.push(`${safeCol(key)} = ?`);
      params.push(val);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const total = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM "${tableName}" ${conditions.length > (cursor ? 1 : 0) ? 'WHERE ' + conditions.slice(cursor ? 1 : 0).join(' AND ') : ''}`
    ).get(...params.slice(cursor ? 3 : 0)) as any)?.cnt ?? 0;

    const rows = this.db.prepare(
      `SELECT * FROM "${tableName}" ${where} ORDER BY slot ASC, id ASC LIMIT ?`
    ).all(...params, limit + 1);

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
    const lastRow = data[data.length - 1];

    return {
      rows: data,
      total,
      nextCursor: hasMore && lastRow ? encodeCursor(lastRow.slot, lastRow.id) : null,
    };
  }

  // ── Events query ──────────────────────────────────────────────────────────

  queryEvents(
    eventName?: string,
    filters: QueryFilters = {},
    opts: { limit?: number; cursor?: string } = {}
  ): CursorPage {
    const tableName = `${this.idl.name}_events`;
    const limit = Math.min(opts.limit ?? 50, 200);

    const conditions: string[] = [];
    const params: any[] = [];

    if (eventName) { conditions.push('event_name = ?'); params.push(eventName); }
    if (filters.slot_from) { conditions.push('slot >= ?'); params.push(filters.slot_from); }
    if (filters.slot_to) { conditions.push('slot <= ?'); params.push(filters.slot_to); }

    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    if (cursor) {
      conditions.push('(slot > ? OR (slot = ? AND id > ?))');
      params.push(cursor.slot, cursor.slot, cursor.id);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT * FROM "${tableName}" ${where} ORDER BY slot ASC, id ASC LIMIT ?`
    ).all(...params, limit + 1);

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
    const lastRow = data[data.length - 1];

    return {
      rows: data.map((r: any) => ({ ...r, data: JSON.parse(r.data) })),
      total: data.length,
      nextCursor: hasMore && lastRow ? encodeCursor(lastRow.slot, lastRow.id) : null,
    };
  }

  // ── Aggregation (extended: SUM/AVG/MIN/MAX) ────────────────────────────────

  aggregate(
    instructionName: string,
    groupBy: 'hour' | 'day' | 'total',
    slotFrom?: number,
    slotTo?: number,
    op: 'count' | 'sum' | 'avg' | 'min' | 'max' = 'count',
    field?: string
  ): any[] {
    const tableName = getInstructionTableName(this.idl.name, instructionName);
    const conditions: string[] = [];
    const params: any[] = [];

    if (slotFrom) { conditions.push('slot >= ?'); params.push(slotFrom); }
    if (slotTo) { conditions.push('slot <= ?'); params.push(slotTo); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Build the aggregation expression
    let aggExpr = 'COUNT(*)';
    if (op !== 'count' && field) {
      if (!SAFE_COL.test(field)) throw new Error(`Unsafe field name: ${field}`);
      // CAST to REAL for numeric operations on TEXT columns
      const col = safeCol(field);
      aggExpr = `${op.toUpperCase()}(CAST(${col} AS REAL))`;
    }

    if (groupBy === 'hour') {
      // Group by block_time hour if available, fallback to slot buckets
      return this.db.prepare(
        `SELECT COALESCE(block_time / 3600, slot / 9000) as bucket, ${aggExpr} as value, COUNT(*) as count FROM "${tableName}" ${where} GROUP BY bucket ORDER BY bucket DESC LIMIT 168`
      ).all(...params);
    }
    if (groupBy === 'day') {
      return this.db.prepare(
        `SELECT COALESCE(block_time / 86400, slot / 216000) as bucket, ${aggExpr} as value, COUNT(*) as count FROM "${tableName}" ${where} GROUP BY bucket ORDER BY bucket DESC LIMIT 30`
      ).all(...params);
    }
    return this.db.prepare(
      `SELECT ${aggExpr} as value, COUNT(*) as total_calls, MIN(slot) as first_slot, MAX(slot) as last_slot FROM "${tableName}" ${where}`
    ).all(...params);
  }

  // ── Account history (append-only log) ─────────────────────────────────────

  insertAccountHistory(
    accountTypeName: string,
    pubkey: string,
    slot: number,
    data: Record<string, any>
  ) {
    const tableName = `acc_history_${this.idl.name}_${accountTypeName}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');

    // Create history table lazily
    const cols = [
      '  id INTEGER PRIMARY KEY AUTOINCREMENT',
      '  pubkey TEXT NOT NULL',
      '  slot INTEGER NOT NULL',
      ...Object.keys(data).map(k => `  "${k.toLowerCase().replace(/[^a-z0-9_]/g, '_')}" TEXT`),
      '  recorded_at INTEGER NOT NULL',
    ];
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "${tableName}" (
      ${cols.join(',\n')}
      );
      CREATE INDEX IF NOT EXISTS "idx_${tableName}_pubkey" ON "${tableName}"(pubkey, slot DESC);
    `);

    const row: Record<string, any> = { pubkey, slot, recorded_at: Date.now() };
    for (const [k, v] of Object.entries(data)) {
      row[k.toLowerCase().replace(/[^a-z0-9_]/g, '_')] = v !== null ? String(v) : null;
    }
    const rowCols = Object.keys(row);
    this.db.prepare(
      `INSERT INTO "${tableName}" (${rowCols.map(c => `"${c}"`).join(', ')}) VALUES (${rowCols.map(() => '?').join(', ')})`
    ).run(...rowCols.map(c => row[c]));
  }

  queryAccountHistory(
    accountTypeName: string,
    pubkey: string,
    opts: { limit?: number; offset?: number } = {}
  ): any[] {
    const tableName = `acc_history_${this.idl.name}_${accountTypeName}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;
    try {
      return this.db.prepare(
        `SELECT * FROM "${tableName}" WHERE pubkey = ? ORDER BY slot DESC LIMIT ? OFFSET ?`
      ).all(pubkey, limit, offset);
    } catch {
      return [];
    }
  }

  // ── Readiness check ───────────────────────────────────────────────────────

  isReady(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  close(): void {
    try {
      this.db.close();
    } catch { /* already closed */ }
  }

  // ── Program stats ─────────────────────────────────────────────────────────

  getProgramStats(): Record<string, any> {
    const stats: Record<string, any> = {
      program: this.idl.name,
      instructions: {},
      events: {},
    };

    for (const ix of this.idl.instructions) {
      const tableName = getInstructionTableName(this.idl.name, ix.name);
      try {
        stats.instructions[ix.name] = this.db.prepare(
          `SELECT COUNT(*) as total, MIN(slot) as first_slot, MAX(slot) as last_slot FROM "${tableName}"`
        ).get();
      } catch { stats.instructions[ix.name] = { total: 0 }; }
    }

    try {
      const eventsTable = `${this.idl.name}_events`;
      const eventStats = this.db.prepare(
        `SELECT event_name, COUNT(*) as count FROM "${eventsTable}" GROUP BY event_name`
      ).all() as any[];
      for (const row of eventStats) stats.events[row.event_name] = row.count;
    } catch { /* no events */ }

    return stats;
  }
}

export function createDb(idl: AnchorIdl, dbPath: string): IndexerRepository {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  logger.info('SQLite connected', { dbPath });
  return new IndexerRepository(db, idl);
}
