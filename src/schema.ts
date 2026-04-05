import Database from 'better-sqlite3';

export interface FieldConfig {
  name: string;
  source: 'account' | 'instruction' | 'log' | 'meta';
  path: string;
  type: 'string' | 'number' | 'boolean';
}

export interface IndexSchema {
  id: string;
  name: string;
  programId?: string;
  accountFilter?: string;
  fields: FieldConfig[];
  createdAt: number;
}

export class SchemaManager {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schemas (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        program_id TEXT,
        account_filter TEXT,
        fields TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS indexed_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_id TEXT NOT NULL,
        signature TEXT NOT NULL,
        slot INTEGER NOT NULL,
        data TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        FOREIGN KEY (schema_id) REFERENCES schemas(id)
      );

      CREATE INDEX IF NOT EXISTS idx_schema_id ON indexed_transactions(schema_id);
      CREATE INDEX IF NOT EXISTS idx_signature ON indexed_transactions(signature);
      CREATE INDEX IF NOT EXISTS idx_slot ON indexed_transactions(slot);
    `);
  }

  createSchema(schema: Omit<IndexSchema, 'createdAt'>): IndexSchema {
    const full: IndexSchema = { ...schema, createdAt: Date.now() };
    this.db.prepare(`
      INSERT INTO schemas (id, name, program_id, account_filter, fields, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      full.id,
      full.name,
      full.programId || null,
      full.accountFilter || null,
      JSON.stringify(full.fields),
      full.createdAt
    );
    return full;
  }

  getSchema(id: string): IndexSchema | null {
    const row = this.db.prepare('SELECT * FROM schemas WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      programId: row.program_id,
      accountFilter: row.account_filter,
      fields: JSON.parse(row.fields),
      createdAt: row.created_at,
    };
  }

  listSchemas(): IndexSchema[] {
    const rows = this.db.prepare('SELECT * FROM schemas').all() as any[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      programId: row.program_id,
      accountFilter: row.account_filter,
      fields: JSON.parse(row.fields),
      createdAt: row.created_at,
    }));
  }

  deleteSchema(id: string): boolean {
    const result = this.db.prepare('DELETE FROM schemas WHERE id = ?').run(id);
    return result.changes > 0;
  }

  saveTransaction(schemaId: string, signature: string, slot: number, data: Record<string, any>) {
    this.db.prepare(`
      INSERT OR IGNORE INTO indexed_transactions (schema_id, signature, slot, data, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(schemaId, signature, slot, JSON.stringify(data), Date.now());
  }

  queryTransactions(schemaId: string, filters: {
    slot_from?: number;
    slot_to?: number;
    limit?: number;
    offset?: number;
  } = {}) {
    let query = 'SELECT * FROM indexed_transactions WHERE schema_id = ?';
    const params: any[] = [schemaId];

    if (filters.slot_from) { query += ' AND slot >= ?'; params.push(filters.slot_from); }
    if (filters.slot_to) { query += ' AND slot <= ?'; params.push(filters.slot_to); }

    query += ' ORDER BY slot DESC';
    query += ` LIMIT ${filters.limit || 100} OFFSET ${filters.offset || 0}`;

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(row => ({
      id: row.id,
      schemaId: row.schema_id,
      signature: row.signature,
      slot: row.slot,
      data: JSON.parse(row.data),
      indexedAt: row.indexed_at,
    }));
  }

  countTransactions(schemaId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM indexed_transactions WHERE schema_id = ?'
    ).get(schemaId) as any;
    return row.cnt;
  }
}
