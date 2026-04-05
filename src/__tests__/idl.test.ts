import {
  computeDiscriminator,
  buildDiscriminatorMap,
  matchInstruction,
  decodeInstructionArgs,
  generateSchemaSQL,
  getInstructionTableName,
  AnchorIdl,
} from '../idl';

const mockIdl: AnchorIdl = {
  name: 'test_program',
  instructions: [
    {
      name: 'transfer',
      accounts: [
        { name: 'from', isMut: true, isSigner: true },
        { name: 'to', isMut: true, isSigner: false },
      ],
      args: [
        { name: 'amount', type: 'u64' },
        { name: 'memo', type: 'string' },
      ],
    },
    {
      name: 'initialize',
      accounts: [{ name: 'authority', isMut: false, isSigner: true }],
      args: [],
    },
  ],
};

describe('computeDiscriminator', () => {
  test('produces 8-byte buffer', () => {
    const disc = computeDiscriminator('transfer');
    expect(disc.length).toBe(8);
  });

  test('different instructions produce different discriminators', () => {
    const d1 = computeDiscriminator('transfer');
    const d2 = computeDiscriminator('initialize');
    expect(d1.toString('hex')).not.toBe(d2.toString('hex'));
  });

  test('same input produces same discriminator (deterministic)', () => {
    const d1 = computeDiscriminator('transfer');
    const d2 = computeDiscriminator('transfer');
    expect(d1.toString('hex')).toBe(d2.toString('hex'));
  });
});

describe('buildDiscriminatorMap', () => {
  test('maps each instruction by discriminator', () => {
    const map = buildDiscriminatorMap(mockIdl);
    expect(map.size).toBe(2);
  });

  test('lookup returns correct instruction', () => {
    const map = buildDiscriminatorMap(mockIdl);
    const disc = computeDiscriminator('transfer').toString('hex');
    const found = map.get(disc);
    expect(found?.name).toBe('transfer');
  });
});

describe('matchInstruction', () => {
  test('matches correct instruction from raw data', () => {
    const map = buildDiscriminatorMap(mockIdl);
    const disc = computeDiscriminator('transfer');
    const rawData = Buffer.concat([disc, Buffer.alloc(16)]);
    const ix = matchInstruction(rawData, map);
    expect(ix?.name).toBe('transfer');
  });

  test('returns null for unknown discriminator', () => {
    const map = buildDiscriminatorMap(mockIdl);
    const rawData = Buffer.alloc(16); // all zeros — unlikely to match
    const ix = matchInstruction(rawData, map);
    expect(ix).toBeNull();
  });

  test('returns null for data shorter than 8 bytes', () => {
    const map = buildDiscriminatorMap(mockIdl);
    const rawData = Buffer.alloc(4);
    expect(matchInstruction(rawData, map)).toBeNull();
  });
});

describe('decodeInstructionArgs', () => {
  test('decodes u64 correctly', () => {
    const args = [{ name: 'amount', type: 'u64' as const }];
    const disc = Buffer.alloc(8);
    // encode 1000 as little-endian u64
    const val = Buffer.alloc(8);
    val.writeBigUInt64LE(BigInt(1000));
    const data = Buffer.concat([disc, val]);
    const result = decodeInstructionArgs(args, data);
    expect(result.amount).toBe('1000');
  });

  test('decodes string correctly', () => {
    const args = [{ name: 'memo', type: 'string' as const }];
    const disc = Buffer.alloc(8);
    const text = Buffer.from('hello', 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(text.length);
    const data = Buffer.concat([disc, lenBuf, text]);
    const result = decodeInstructionArgs(args, data);
    expect(result.memo).toBe('hello');
  });

  test('returns null for truncated data', () => {
    const args = [{ name: 'amount', type: 'u64' as const }];
    const data = Buffer.alloc(4); // too short
    const result = decodeInstructionArgs(args, data);
    expect(result.amount).toBeNull();
  });
});

describe('generateSchemaSQL', () => {
  test('generates CREATE TABLE for each instruction', () => {
    const sql = generateSchemaSQL(mockIdl);
    expect(sql).toContain('ix_test_program_transfer');
    expect(sql).toContain('ix_test_program_initialize');
  });

  test('includes arg columns', () => {
    const sql = generateSchemaSQL(mockIdl);
    expect(sql).toContain('arg_amount');
    expect(sql).toContain('arg_memo');
  });

  test('includes account columns', () => {
    const sql = generateSchemaSQL(mockIdl);
    expect(sql).toContain('account_from');
    expect(sql).toContain('account_to');
  });

  test('includes _indexer_state table', () => {
    const sql = generateSchemaSQL(mockIdl);
    expect(sql).toContain('_indexer_state');
  });
});

describe('getInstructionTableName', () => {
  test('produces safe table name', () => {
    expect(getInstructionTableName('myProgram', 'myInstruction')).toBe('ix_myprogram_myinstruction');
  });

  test('replaces special chars', () => {
    expect(getInstructionTableName('my-program', 'my-ix')).toBe('ix_my_program_my_ix');
  });
});
