/**
 * IDL-based schema generation and decoding.
 * Supports Anchor IDL format (v0.26+).
 */
import * as crypto from 'crypto';

export interface IdlField {
  name: string;
  type: IdlType;
}

export type IdlType =
  | 'bool' | 'u8' | 'u16' | 'u32' | 'u64' | 'u128'
  | 'i8' | 'i16' | 'i32' | 'i64' | 'i128'
  | 'f32' | 'f64' | 'string' | 'publicKey'
  | { vec: IdlType }
  | { option: IdlType }
  | { defined: string }
  | { array: [IdlType, number] };

export interface IdlInstruction {
  name: string;
  accounts: { name: string; isMut: boolean; isSigner: boolean }[];
  args: IdlField[];
}

export interface IdlAccount {
  name: string;
  type: { kind: 'struct'; fields: IdlField[] };
}

export interface IdlTypeDef {
  name: string;
  type: { kind: 'struct' | 'enum'; fields?: IdlField[]; variants?: { name: string }[] };
}

export interface AnchorIdl {
  name: string;
  version?: string;
  instructions: IdlInstruction[];
  accounts?: IdlAccount[];
  types?: IdlTypeDef[];
}

// ─── Discriminator ────────────────────────────────────────────────────────────

/**
 * Compute Anchor 8-byte instruction discriminator.
 * sha256("global:{instruction_name}")[0..8]
 */
export function computeDiscriminator(ixName: string): Buffer {
  const hash = crypto.createHash('sha256').update(`global:${ixName}`).digest();
  return hash.slice(0, 8);
}

/**
 * Build a discriminator → instruction map for fast lookup.
 */
export function buildDiscriminatorMap(idl: AnchorIdl): Map<string, IdlInstruction> {
  const map = new Map<string, IdlInstruction>();
  for (const ix of idl.instructions) {
    const disc = computeDiscriminator(ix.name).toString('hex');
    map.set(disc, ix);
  }
  return map;
}

/**
 * Match raw instruction data to an IDL instruction by discriminator.
 * Returns null if no match.
 */
export function matchInstruction(
  rawData: Buffer,
  discriminatorMap: Map<string, IdlInstruction>
): IdlInstruction | null {
  if (rawData.length < 8) return null;
  const disc = rawData.slice(0, 8).toString('hex');
  return discriminatorMap.get(disc) ?? null;
}

// ─── SQL schema generation ────────────────────────────────────────────────────

function idlTypeToSql(type: IdlType): string {
  if (type === 'bool') return 'INTEGER';
  if (type === 'string' || type === 'publicKey') return 'TEXT';
  if (type === 'u64' || type === 'u128' || type === 'i64' || type === 'i128') return 'TEXT'; // BigInt as string
  if (typeof type === 'string') return 'INTEGER'; // u8..u32, i8..i32
  if ('vec' in type) return 'TEXT'; // JSON
  if ('option' in type) return idlTypeToSql(type.option);
  if ('defined' in type) return 'TEXT'; // JSON
  if ('array' in type) return 'TEXT'; // JSON
  return 'TEXT';
}

export function generateSchemaSQL(idl: AnchorIdl): string {
  const parts: string[] = [];

  parts.push(`
CREATE TABLE IF NOT EXISTS _indexer_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`);

  for (const ix of idl.instructions) {
    const tableName = getInstructionTableName(idl.name, ix.name);
    const cols = [
      '  id INTEGER PRIMARY KEY AUTOINCREMENT',
      '  signature TEXT NOT NULL UNIQUE',
      '  slot INTEGER NOT NULL',
      '  block_time INTEGER',
      ...ix.accounts.map(a => `  account_${a.name.toLowerCase()} TEXT`),
      ...ix.args.map(a => `  arg_${a.name.toLowerCase()} ${idlTypeToSql(a.type)}`),
      '  indexed_at INTEGER NOT NULL',
    ];
    parts.push(`
CREATE TABLE IF NOT EXISTS ${tableName} (
${cols.join(',\n')}
);
CREATE INDEX IF NOT EXISTS idx_${tableName}_slot ON ${tableName}(slot);`);
  }

  if (idl.accounts) {
    for (const acc of idl.accounts) {
      const tableName = getAccountTableName(idl.name, acc.name);
      const cols = [
        '  id INTEGER PRIMARY KEY AUTOINCREMENT',
        '  pubkey TEXT NOT NULL UNIQUE',
        '  slot INTEGER NOT NULL',
        ...acc.type.fields.map(f => `  ${f.name.toLowerCase()} ${idlTypeToSql(f.type)}`),
        '  updated_at INTEGER NOT NULL',
      ];
      parts.push(`
CREATE TABLE IF NOT EXISTS ${tableName} (
${cols.join(',\n')}
);`);
    }
  }

  return parts.join('\n');
}

export function getInstructionTableName(programName: string, ixName: string): string {
  return `ix_${programName}_${ixName}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

export function getAccountTableName(programName: string, accName: string): string {
  return `acc_${programName}_${accName}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

// ─── Decoding ─────────────────────────────────────────────────────────────────

export function decodeInstructionArgs(
  args: IdlField[],
  rawData: Buffer
): Record<string, any> {
  const result: Record<string, any> = {};
  let offset = 8; // skip 8-byte discriminator

  for (const field of args) {
    try {
      const [value, newOffset] = decodeField(field.type, rawData, offset);
      result[field.name] = value;
      offset = newOffset;
    } catch {
      result[field.name] = null;
    }
  }
  return result;
}

export function decodeField(type: IdlType, data: Buffer, offset: number): [any, number] {
  if (data.length <= offset) return [null, offset];

  if (type === 'bool') return [data[offset] !== 0, offset + 1];
  if (type === 'u8') return [data.readUInt8(offset), offset + 1];
  if (type === 'u16') return [data.readUInt16LE(offset), offset + 2];
  if (type === 'u32') return [data.readUInt32LE(offset), offset + 4];
  if (type === 'i8') return [data.readInt8(offset), offset + 1];
  if (type === 'i16') return [data.readInt16LE(offset), offset + 2];
  if (type === 'i32') return [data.readInt32LE(offset), offset + 4];
  if (type === 'u64') {
    const lo = data.readUInt32LE(offset);
    const hi = data.readUInt32LE(offset + 4);
    const val = BigInt(hi) * BigInt(0x100000000) + BigInt(lo);
    return [val.toString(), offset + 8];
  }
  if (type === 'i64') {
    const lo = data.readUInt32LE(offset);
    const hi = data.readInt32LE(offset + 4);
    const val = BigInt(hi) * BigInt(0x100000000) + BigInt(lo);
    return [val.toString(), offset + 8];
  }
  if (type === 'u128' || type === 'i128') {
    const bytes = data.slice(offset, offset + 16);
    return [`0x${bytes.reverse().toString('hex')}`, offset + 16];
  }
  if (type === 'f32') return [data.readFloatLE(offset), offset + 4];
  if (type === 'f64') return [data.readDoubleLE(offset), offset + 8];
  if (type === 'publicKey') {
    const bytes = data.slice(offset, offset + 32);
    return [bytes.toString('base64'), offset + 32]; // base64 for storage
  }
  if (type === 'string') {
    if (offset + 4 > data.length) return [null, offset];
    const len = data.readUInt32LE(offset);
    if (offset + 4 + len > data.length) return [null, offset];
    const str = data.slice(offset + 4, offset + 4 + len).toString('utf8');
    return [str, offset + 4 + len];
  }
  if (typeof type === 'object') {
    if ('option' in type) {
      if (data[offset] === 0) return [null, offset + 1];
      return decodeField(type.option, data, offset + 1);
    }
    if ('vec' in type) {
      if (offset + 4 > data.length) return [null, offset];
      const len = data.readUInt32LE(offset);
      let cur = offset + 4;
      const arr: any[] = [];
      for (let i = 0; i < len && cur < data.length; i++) {
        const [val, next] = decodeField(type.vec, data, cur);
        arr.push(val);
        cur = next;
      }
      return [JSON.stringify(arr), cur];
    }
    if ('array' in type) {
      const [elemType, count] = type.array;
      let cur = offset;
      const arr: any[] = [];
      for (let i = 0; i < count; i++) {
        const [val, next] = decodeField(elemType, data, cur);
        arr.push(val);
        cur = next;
      }
      return [JSON.stringify(arr), cur];
    }
    if ('defined' in type) {
      return [null, offset]; // custom types need type registry
    }
  }
  return [null, offset];
}
