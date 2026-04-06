/**
 * IDL Version Manager
 *
 * Real Anchor programs upgrade over time. This module tracks IDL versions
 * and applies schema migrations when the program's IDL changes.
 *
 * Tracks IDL version changes and applies schema migrations automatically.
 */
import * as crypto from 'crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorIdl, generateSchemaSQL } from '../idl/parser';
import { logger } from '../observability/logger';

export interface IdlVersion {
  programId: string;
  idl: AnchorIdl;
  hash: string;
  registeredAt: number;
  slot: number;
}

function hashIdl(idl: AnchorIdl): string {
  return crypto.createHash('sha256').update(JSON.stringify(idl)).digest('hex').slice(0, 16);
}

export class IdlVersionManager {
  private currentVersion: IdlVersion | null = null;

  constructor(
    private programId: string,
    private db: any // sqlite client
  ) {
    this.initTable();
  }

  private initTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _idl_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        program_id TEXT NOT NULL,
        idl_hash TEXT NOT NULL,
        idl_json TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        slot INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_idl_versions_program ON _idl_versions(program_id, registered_at DESC);
    `);
  }

  /**
   * Register initial IDL (from file).
   */
  registerIdl(idl: AnchorIdl, slot = 0): IdlVersion {
    const hash = hashIdl(idl);

    // Check if already registered
    const existing = this.db.prepare(
      'SELECT * FROM _idl_versions WHERE program_id = ? AND idl_hash = ?'
    ).get(this.programId, hash) as any;

    if (existing) {
      logger.info('IDL already registered', { program: idl.name, hash });
      this.currentVersion = { programId: this.programId, idl, hash, registeredAt: existing.registered_at, slot: existing.slot };
      return this.currentVersion;
    }

    const now = Date.now();
    this.db.prepare(
      'INSERT INTO _idl_versions (program_id, idl_hash, idl_json, registered_at, slot) VALUES (?, ?, ?, ?, ?)'
    ).run(this.programId, hash, JSON.stringify(idl), now, slot);

    this.currentVersion = { programId: this.programId, idl, hash, registeredAt: now, slot };
    logger.info('IDL version registered', { program: idl.name, hash, slot });
    return this.currentVersion;
  }

  /**
   * Check if the IDL has changed and register new version if so.
   * Returns true if upgrade detected.
   */
  async checkForUpgrade(newIdl: AnchorIdl, currentSlot: number): Promise<boolean> {
    const newHash = hashIdl(newIdl);
    if (this.currentVersion?.hash === newHash) return false;

    logger.info('IDL upgrade detected!', {
      program: newIdl.name,
      oldHash: this.currentVersion?.hash,
      newHash,
      slot: currentSlot,
    });

    // Migrate schema: add new columns if any
    if (this.currentVersion) {
      await this.migrateSchema(this.currentVersion.idl, newIdl);
    }

    this.registerIdl(newIdl, currentSlot);
    return true;
  }

  /**
   * Apply schema migration when IDL changes.
   * Adds new columns for new instructions/accounts.
   * Does NOT drop old columns (backward compatible).
   */
  private async migrateSchema(oldIdl: AnchorIdl, newIdl: AnchorIdl): Promise<void> {
    // Find new instructions
    const oldIxNames = new Set(oldIdl.instructions.map(ix => ix.name));
    const newInstructions = newIdl.instructions.filter(ix => !oldIxNames.has(ix.name));

    // Generate and apply DDL for new instruction tables
    if (newInstructions.length > 0) {
      const tempIdl = { ...newIdl, instructions: newInstructions, accounts: [] };
      const ddl = generateSchemaSQL(tempIdl);
      this.db.exec(ddl);
      logger.info('Schema migrated: new instruction tables created', {
        newInstructions: newInstructions.map(ix => ix.name),
      });
    }

    // Check for new args in existing instructions
    for (const newIx of newIdl.instructions) {
      const oldIx = oldIdl.instructions.find(ix => ix.name === newIx.name);
      if (!oldIx) continue;

      const oldArgNames = new Set(oldIx.args.map(a => a.name));
      const newArgs = newIx.args.filter(a => !oldArgNames.has(a.name));

      if (newArgs.length > 0) {
        const tableName = `ix_${newIdl.name}_${newIx.name}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        for (const arg of newArgs) {
          try {
            this.db.exec(`ALTER TABLE "${tableName}" ADD COLUMN "arg_${arg.name.toLowerCase()}" TEXT`);
            logger.info('Added column', { table: tableName, column: arg.name });
          } catch {
            // Column already exists
          }
        }
      }
    }
  }

  /**
   * Fetch IDL from on-chain Anchor program account.
   * Falls back gracefully if not available.
   */
  static async fetchFromChain(programId: string, connection: Connection): Promise<AnchorIdl | null> {
    try {
      // Anchor IDL account PDA: seeds = ["anchor:idl"], program = programId
      const [idlAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('anchor:idl')],
        new PublicKey(programId)
      );

      const accountInfo = await connection.getAccountInfo(idlAddress);
      if (!accountInfo?.data) return null;

      // IDL account data layout:
      // 8 bytes discriminator + 32 bytes authority + 4 bytes data length + data (zlib-compressed)
      const data = accountInfo.data;
      if (data.length < 44) return null;

      const idlDataStart = 8 + 32; // discriminator + authority pubkey
      const idlLength = data.readUInt32LE(idlDataStart);
      const idlBytes = data.slice(idlDataStart + 4, idlDataStart + 4 + idlLength);

      // Try to decompress (Anchor stores IDL as zlib-compressed JSON)
      let idlJson: AnchorIdl;
      try {
        const zlib = require('zlib');
        const decompressed = zlib.inflateSync(idlBytes);
        idlJson = JSON.parse(decompressed.toString('utf8'));
      } catch {
        // Fallback: try raw JSON (some older programs may store uncompressed)
        idlJson = JSON.parse(idlBytes.toString('utf8'));
      }

      logger.info('IDL fetched from chain', { programId, name: idlJson.name });
      return idlJson;
    } catch (err: any) {
      logger.debug('Could not fetch IDL from chain', { programId, error: err.message });
      return null;
    }
  }

  getCurrentVersion(): IdlVersion | null {
    return this.currentVersion;
  }

  getVersionHistory(): IdlVersion[] {
    const rows = this.db.prepare(
      'SELECT * FROM _idl_versions WHERE program_id = ? ORDER BY registered_at ASC'
    ).all(this.programId) as any[];

    return rows.map(row => ({
      programId: row.program_id,
      idl: JSON.parse(row.idl_json),
      hash: row.idl_hash,
      registeredAt: row.registered_at,
      slot: row.slot,
    }));
  }
}
