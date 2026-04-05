/**
 * IDL-based schema generation and decoding.
 * Supports Anchor IDL format (v0.26+).
 */

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

export interface GeneratedSchema {
  programName: string;
  instructionTables: { tableName: string; instruction: IdlInstruction }[];
  accountTables: { tableName: string; account: IdlAccount }[];
}

function idlTypeToSql(type: IdlType): string {
  if (type === 'bool') return 'INTEGER'; // 0 or 1
  if (type === 'string' || type === 'publicKey') return 'TEXT';
  if (typeof type === 'string') return 'TEXT'; // numbers stored as text for precision
  if ('vec' in type) return 'TEXT'; // JSON array
  if ('option' in type) return idlTypeToSql(type.option) + ' -- nullable';
  if ('defined' in type) return 'TEXT'; // JSON
  if ('array' in type) return 'TEXT'; // JSON array
  return 'TEXT';
}

export function generateSchemaSQL(idl: AnchorIdl): string {
  const parts: string[] = [];

  // State tracking table
  parts.push(`
CREATE TABLE IF NOT EXISTS _indexer_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`);

  // Instruction tables
  for (const ix of idl.instructions) {
    const tableName = `ix_${idl.name}_${ix.name}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const cols = [
      '  id INTEGER PRIMARY KEY AUTOINCREMENT',
      '  signature TEXT NOT NULL',
      '  slot INTEGER NOT NULL',
      '  block_time INTEGER',
      // accounts
      ...ix.accounts.map(a => `  account_${a.name.toLowerCase()} TEXT`),
      // args
      ...ix.args.map(a => `  arg_${a.name.toLowerCase()} ${idlTypeToSql(a.type)}`),
      '  indexed_at INTEGER NOT NULL',
    ];
    parts.push(`
CREATE TABLE IF NOT EXISTS ${tableName} (
${cols.join(',\n')}
);
CREATE INDEX IF NOT EXISTS idx_${tableName}_slot ON ${tableName}(slot);
CREATE INDEX IF NOT EXISTS idx_${tableName}_sig ON ${tableName}(signature);`);
  }

  // Account state tables
  if (idl.accounts) {
    for (const acc of idl.accounts) {
      const tableName = `acc_${idl.name}_${acc.name}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const cols = [
        '  id INTEGER PRIMARY KEY AUTOINCREMENT',
        '  pubkey TEXT NOT NULL',
        '  slot INTEGER NOT NULL',
        // fields
        ...acc.type.fields.map(f => `  ${f.name.toLowerCase()} ${idlTypeToSql(f.type)}`),
        '  updated_at INTEGER NOT NULL',
      ];
      parts.push(`
CREATE TABLE IF NOT EXISTS ${tableName} (
${cols.join(',\n')}
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${tableName}_pubkey ON ${tableName}(pubkey);`);
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

/**
 * Basic value decoder from raw instruction data.
 * For full decoding, use @coral-xyz/anchor BorshCoder.
 */
export function decodeInstructionArgs(
  args: IdlField[],
  rawData: Uint8Array
): Record<string, any> {
  // Attempt basic decoding — for demo, return hex + field names
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

function decodeField(type: IdlType, data: Uint8Array, offset: number): [any, number] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  if (type === 'bool') return [data[offset] !== 0, offset + 1];
  if (type === 'u8') return [data[offset], offset + 1];
  if (type === 'u16') return [view.getUint16(offset, true), offset + 2];
  if (type === 'u32') return [view.getUint32(offset, true), offset + 4];
  if (type === 'u64') {
    const lo = view.getUint32(offset, true);
    const hi = view.getUint32(offset + 4, true);
    return [BigInt(hi) * BigInt(0x100000000) + BigInt(lo), offset + 8];
  }
  if (type === 'i32') return [view.getInt32(offset, true), offset + 4];
  if (type === 'i64') {
    const lo = view.getInt32(offset, true);
    const hi = view.getInt32(offset + 4, true);
    return [BigInt(hi) * BigInt(0x100000000) + BigInt(lo), offset + 8];
  }
  if (type === 'publicKey') {
    const bytes = data.slice(offset, offset + 32);
    return [Buffer.from(bytes).toString('hex'), offset + 32];
  }
  if (type === 'string') {
    const len = view.getUint32(offset, true);
    const str = Buffer.from(data.slice(offset + 4, offset + 4 + len)).toString('utf8');
    return [str, offset + 4 + len];
  }
  if (typeof type === 'object' && 'option' in type) {
    const isSome = data[offset] !== 0;
    if (!isSome) return [null, offset + 1];
    return decodeField(type.option, data, offset + 1);
  }

  return [null, offset];
}
