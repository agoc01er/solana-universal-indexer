/**
 * Simple test runner — no jest dependency required.
 * Runs all test suites inline and reports results.
 */
import * as crypto from 'crypto';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.then(() => {
        console.log(`  ✅ ${name}`);
        passed++;
      }).catch((err: any) => {
        console.log(`  ❌ ${name}: ${err.message}`);
        failed++;
        failures.push(name);
      });
    } else {
      console.log(`  ✅ ${name}`);
      passed++;
    }
  } catch (err: any) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
    failures.push(name);
  }
}

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toEqual: (expected: any) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toBeNull: () => {
      if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
    },
    not: {
      toBeNull: () => {
        if (actual === null) throw new Error(`Expected non-null value`);
      },
      toBe: (val: any) => {
        if (actual === val) throw new Error(`Expected not ${JSON.stringify(val)}`);
      },
    },
    toBeGreaterThanOrEqual: (n: number) => {
      if (actual < n) throw new Error(`Expected >= ${n}, got ${actual}`);
    },
    toThrow: () => { /* handled above */ },
  };
}

// ── IDL Tests ───────────────────────────────────────────────────────────────

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

console.log('\n📦 IDL Tests');

test('computeDiscriminator produces 8 bytes', () => {
  const disc = computeDiscriminator('transfer');
  if (disc.length !== 8) throw new Error(`Expected 8, got ${disc.length}`);
});

test('different instructions produce different discriminators', () => {
  const d1 = computeDiscriminator('transfer');
  const d2 = computeDiscriminator('initialize');
  if (d1.toString('hex') === d2.toString('hex')) throw new Error('Discriminators should differ');
});

test('same input = same discriminator (deterministic)', () => {
  const d1 = computeDiscriminator('transfer');
  const d2 = computeDiscriminator('transfer');
  if (d1.toString('hex') !== d2.toString('hex')) throw new Error('Should be deterministic');
});

test('discriminator map has correct size', () => {
  const map = buildDiscriminatorMap(mockIdl);
  if (map.size !== 2) throw new Error(`Expected 2, got ${map.size}`);
});

test('discriminator map lookup returns correct instruction', () => {
  const map = buildDiscriminatorMap(mockIdl);
  const disc = computeDiscriminator('transfer').toString('hex');
  const found = map.get(disc);
  if (found?.name !== 'transfer') throw new Error(`Expected 'transfer', got '${found?.name}'`);
});

test('matchInstruction matches correct instruction', () => {
  const map = buildDiscriminatorMap(mockIdl);
  const disc = computeDiscriminator('transfer');
  const rawData = Buffer.concat([disc, Buffer.alloc(16)]);
  const ix = matchInstruction(rawData, map);
  if (ix?.name !== 'transfer') throw new Error(`Expected 'transfer', got '${ix?.name}'`);
});

test('matchInstruction returns null for unknown', () => {
  const map = buildDiscriminatorMap(mockIdl);
  const rawData = Buffer.alloc(16);
  const ix = matchInstruction(rawData, map);
  if (ix !== null) throw new Error(`Expected null`);
});

test('matchInstruction returns null for short data', () => {
  const map = buildDiscriminatorMap(mockIdl);
  const rawData = Buffer.alloc(4);
  const ix = matchInstruction(rawData, map);
  if (ix !== null) throw new Error(`Expected null`);
});

test('decodeInstructionArgs decodes u64', () => {
  const args = [{ name: 'amount', type: 'u64' as const }];
  const disc = Buffer.alloc(8);
  const val = Buffer.alloc(8);
  val.writeBigUInt64LE(BigInt(1000));
  const data = Buffer.concat([disc, val]);
  const result = decodeInstructionArgs(args, data);
  if (result.amount !== '1000') throw new Error(`Expected '1000', got '${result.amount}'`);
});

test('decodeInstructionArgs decodes string', () => {
  const args = [{ name: 'memo', type: 'string' as const }];
  const disc = Buffer.alloc(8);
  const text = Buffer.from('hello', 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(text.length);
  const data = Buffer.concat([disc, lenBuf, text]);
  const result = decodeInstructionArgs(args, data);
  if (result.memo !== 'hello') throw new Error(`Expected 'hello', got '${result.memo}'`);
});

test('generateSchemaSQL creates tables', () => {
  const sql = generateSchemaSQL(mockIdl);
  if (!sql.includes('ix_test_program_transfer')) throw new Error('Missing transfer table');
  if (!sql.includes('ix_test_program_initialize')) throw new Error('Missing initialize table');
  if (!sql.includes('_indexer_state')) throw new Error('Missing state table');
});

// ── Retry Tests ──────────────────────────────────────────────────────────────

import { withRetry, sleep } from '../retry';

console.log('\n🔄 Retry Tests');

test('withRetry: returns result on first success', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return 'ok'; });
  if (result !== 'ok') throw new Error('Expected ok');
  if (calls !== 1) throw new Error(`Expected 1 call, got ${calls}`);
});

test('withRetry: retries on failure and succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('fail');
    return 'success';
  }, { maxAttempts: 5, initialDelayMs: 1 });
  if (result !== 'success') throw new Error('Expected success');
  if (calls !== 3) throw new Error(`Expected 3 calls, got ${calls}`);
});

test('withRetry: throws after max attempts', async () => {
  try {
    await withRetry(async () => { throw new Error('always'); }, { maxAttempts: 2, initialDelayMs: 1 });
    throw new Error('Should have thrown');
  } catch (err: any) {
    if (err.message !== 'always') throw new Error(`Wrong error: ${err.message}`);
  }
});

// ── DB Tests ──────────────────────────────────────────────────────────────────

import { IndexerRepository } from '../db';

const dbIdl: AnchorIdl = {
  name: 'db_test',
  instructions: [
    {
      name: 'swap',
      accounts: [{ name: 'user', isMut: false, isSigner: true }],
      args: [{ name: 'amount', type: 'u64' }],
    },
  ],
  accounts: [],
};

function makeRepo(): IndexerRepository {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  return new IndexerRepository(db, dbIdl);
}

console.log('\n🗄️ DB Tests');

test('db: state get/set', () => {
  const repo = makeRepo();
  repo.setState('k', 'v');
  if (repo.getState('k') !== 'v') throw new Error('State not saved');
});

test('db: missing key returns null', () => {
  const repo = makeRepo();
  if (repo.getState('missing') !== null) throw new Error('Expected null');
});

test('db: lastProcessedSlot defaults to 0', () => {
  const repo = makeRepo();
  if (repo.getLastProcessedSlot() !== 0) throw new Error('Expected 0');
});

test('db: setLastProcessedSlot persists', () => {
  const repo = makeRepo();
  repo.setLastProcessedSlot(999);
  if (repo.getLastProcessedSlot() !== 999) throw new Error('Expected 999');
});

test('db: insertInstruction stores row', () => {
  const repo = makeRepo();
  repo.insertInstruction('swap', 'sig1', 100, null, { user: 'pk' }, { amount: '500' }, { cpiDepth: 0, parentIxIndex: null });
  const r = repo.queryInstructions('swap', {}, { limit: 10 });
  if (r.rows.length !== 1) throw new Error(`Expected 1, got ${r.rows.length}`);
  if (r.rows[0].signature !== 'sig1') throw new Error('Wrong signature');
});

test('db: deduplicates by signature', () => {
  const repo = makeRepo();
  repo.insertInstruction('swap', 'dup', 1, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });
  repo.insertInstruction('swap', 'dup', 1, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });
  const r = repo.queryInstructions('swap', {}, {});
  if (r.rows.length !== 1) throw new Error(`Expected 1, got ${r.rows.length}`);
});

test('db: slot_from filter works', () => {
  const repo = makeRepo();
  for (let i = 1; i <= 5; i++) {
    repo.insertInstruction('swap', `sig${i}`, i * 100, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });
  }
  const r = repo.queryInstructions('swap', { slot_from: 300 }, {});
  if (r.rows.length !== 3) throw new Error(`Expected 3, got ${r.rows.length}`);
});

test('db: cursor pagination', () => {
  const repo = makeRepo();
  for (let i = 0; i < 5; i++) {
    repo.insertInstruction('swap', `cp${i}`, i, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });
  }
  const r = repo.queryInstructions('swap', {}, { limit: 2 });
  if (r.rows.length !== 2) throw new Error(`Expected 2, got ${r.rows.length}`);
  if (r.nextCursor === null) throw new Error('Expected nextCursor');
});

test('db: SQL injection protection (unsafe key ignored)', () => {
  const repo = makeRepo();
  // Should not throw, unsafe key silently ignored
  const r = repo.queryInstructions('swap', { "'; DROP TABLE--": 'x' }, {});
  if (!Array.isArray(r.rows)) throw new Error('Should return rows array');
});

// ── Event Tests ───────────────────────────────────────────────────────────────

import { EventDecoder } from '../events';

const evIdl: any = {
  name: 'ev_test',
  instructions: [],
  accounts: [],
  events: [
    {
      name: 'TradeExecuted',
      fields: [
        { name: 'amount', type: 'u64' },
        { name: 'side', type: 'u8' },
      ],
    },
  ],
};

function makeEventLog(eventName: string, dataBytes: Buffer): string {
  const disc = crypto.createHash('sha256').update(`event:${eventName}`).digest().slice(0, 8);
  const payload = Buffer.concat([disc, dataBytes]);
  return `Program data: ${payload.toString('base64')}`;
}

console.log('\n⚡ Event Decoder Tests');

test('events: hasEvents true when IDL has events', () => {
  const d = new EventDecoder(evIdl);
  if (!d.hasEvents) throw new Error('Expected hasEvents=true');
});

test('events: hasEvents false when no events', () => {
  const d = new EventDecoder({ name: 'x', instructions: [], accounts: [] });
  if (d.hasEvents) throw new Error('Expected hasEvents=false');
});

test('events: decodes TradeExecuted from logs', () => {
  const d = new EventDecoder(evIdl);
  const data = Buffer.alloc(9);
  data.writeBigUInt64LE(BigInt(1000), 0);
  data.writeUInt8(1, 8);
  const logs = [makeEventLog('TradeExecuted', data)];
  const events = d.decodeFromLogs(logs, 100, 'sig_ev');
  if (events.length !== 1) throw new Error(`Expected 1, got ${events.length}`);
  if (events[0].name !== 'TradeExecuted') throw new Error('Wrong event name');
  if (events[0].data.amount !== '1000') throw new Error(`Wrong amount: ${events[0].data.amount}`);
});

test('events: ignores non-event logs', () => {
  const d = new EventDecoder(evIdl);
  const logs = ['Program log: test', 'Program consumed: 1000 units'];
  const events = d.decodeFromLogs(logs, 1, 'sig1');
  if (events.length !== 0) throw new Error(`Expected 0, got ${events.length}`);
});

test('events: handles malformed base64 gracefully', () => {
  const d = new EventDecoder(evIdl);
  const logs = ['Program data: !!!invalid!!!'];
  // Should not throw
  d.decodeFromLogs(logs, 1, 'sig1');
});

// ── Summary ──────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('Failed tests:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  } else {
    console.log('✅ All tests passed!');
    process.exit(0);
  }
}, 500);
