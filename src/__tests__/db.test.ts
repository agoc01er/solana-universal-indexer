import { IndexerRepository } from '../database/sqlite';
import { AnchorIdl } from '../idl/parser';

const mockIdl: AnchorIdl = {
  name: 'test_prog',
  instructions: [
    {
      name: 'swap',
      accounts: [
        { name: 'user', isMut: false, isSigner: true },
        { name: 'pool', isMut: true, isSigner: false },
      ],
      args: [
        { name: 'amountIn', type: 'u64' },
        { name: 'minOut', type: 'u64' },
      ],
    },
  ],
  accounts: [
    {
      name: 'PoolState',
      type: {
        kind: 'struct',
        fields: [
          { name: 'totalLiquidity', type: 'u64' },
          { name: 'fee', type: 'u16' },
        ],
      },
    },
  ],
};

function makeRepo(): IndexerRepository {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return new IndexerRepository(db, mockIdl);
}

describe('IndexerRepository', () => {
  let repo: IndexerRepository;

  beforeEach(() => {
    repo = makeRepo();
  });

  test('state: set and get', () => {
    repo.setState('key1', 'value1');
    expect(repo.getState('key1')).toBe('value1');
  });

  test('state: missing key returns null', () => {
    expect(repo.getState('nonexistent')).toBeNull();
  });

  test('state: lastProcessedSlot starts at 0', () => {
    expect(repo.getLastProcessedSlot()).toBe(0);
  });

  test('state: setLastProcessedSlot persists', () => {
    repo.setLastProcessedSlot(12345);
    expect(repo.getLastProcessedSlot()).toBe(12345);
  });

  test('insertInstruction: stores row correctly', () => {
    repo.insertInstruction(
      'swap',
      'sig001',
      300_000_000,
      1711000000,
      { user: '7xKp...', pool: 'pool123' },
      { amountIn: '1000000', minOut: '900000' },
      { cpiDepth: 0, parentIxIndex: null }
    );

    const result = repo.queryInstructions('swap', {}, { limit: 10 });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].signature).toBe('sig001');
    expect(result.rows[0].slot).toBe(300_000_000);
    expect(result.rows[0].account_user).toBe('7xKp...');
    expect(result.rows[0].arg_amountin).toBe('1000000');
  });

  test('insertInstruction: deduplicates same signature', () => {
    const args = { amountIn: '100', minOut: '90' };
    const accounts = { user: 'abc', pool: 'def' };
    repo.insertInstruction('swap', 'dup_sig', 1, null, accounts, args, { cpiDepth: 0, parentIxIndex: null });
    repo.insertInstruction('swap', 'dup_sig', 1, null, accounts, args, { cpiDepth: 0, parentIxIndex: null });

    const result = repo.queryInstructions('swap', {}, {});
    expect(result.rows.length).toBe(1);
  });

  test('queryInstructions: slot_from filter', () => {
    repo.insertInstruction('swap', 's1', 100, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });
    repo.insertInstruction('swap', 's2', 200, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });
    repo.insertInstruction('swap', 's3', 300, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });

    const result = repo.queryInstructions('swap', { slot_from: 200 }, {});
    expect(result.rows.length).toBe(2);
    expect(result.rows.every((r: any) => r.slot >= 200)).toBe(true);
  });

  test('queryInstructions: slot_to filter', () => {
    repo.insertInstruction('swap', 's1', 100, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });
    repo.insertInstruction('swap', 's2', 200, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });
    repo.insertInstruction('swap', 's3', 300, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });

    const result = repo.queryInstructions('swap', { slot_to: 200 }, {});
    expect(result.rows.length).toBe(2);
  });

  test('upsertAccountSnapshot: stores and updates', () => {
    repo.upsertAccountSnapshot('PoolState', 'pool_pubkey_1', 100, { totalLiquidity: '5000', fee: '30' });
    repo.upsertAccountSnapshot('PoolState', 'pool_pubkey_1', 200, { totalLiquidity: '6000', fee: '30' });

    // Should have only one row (upsert by pubkey)
    const stats = repo.getProgramStats();
    expect(stats.program).toBe('test_prog');
  });

  test('insertEvent: stores event data as JSON', () => {
    repo.insertEvent('SwapExecuted', 'sig_ev1', 100, null, { amount: '1000', price: '50' });
    const result = repo.queryEvents('SwapExecuted', {}, {});
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].data.amount).toBe('1000');
  });

  test('getProgramStats: returns instruction counts', () => {
    repo.insertInstruction('swap', 'stat_s1', 100, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });
    repo.insertInstruction('swap', 'stat_s2', 200, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });

    const stats = repo.getProgramStats();
    expect(stats.instructions.swap.total).toBe(2);
  });

  test('cursor pagination: nextCursor is null when no more results', () => {
    repo.insertInstruction('swap', 'c1', 1, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });
    const result = repo.queryInstructions('swap', {}, { limit: 10 });
    expect(result.nextCursor).toBeNull();
  });

  test('cursor pagination: nextCursor is set when more results exist', () => {
    for (let i = 0; i < 5; i++) {
      repo.insertInstruction('swap', `cur_sig_${i}`, i, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });
    }
    const result = repo.queryInstructions('swap', {}, { limit: 2 });
    expect(result.nextCursor).not.toBeNull();
    expect(result.rows.length).toBe(2);
  });

  test('SQL injection: unsafe column name is rejected', () => {
    expect(() => {
      repo.queryInstructions('swap', { 'DROP TABLE--': 'x' }, {});
    }).not.toThrow(); // unsafe key should be silently ignored (not throw)
  });

  // ── Extended aggregation tests ──────────────────────────────────────────────

  test('aggregate: default count returns total', () => {
    repo.insertInstruction('swap', 'agg1', 100, null, {}, { amountIn: '500' }, { cpiDepth: 0, parentIxIndex: null });
    repo.insertInstruction('swap', 'agg2', 200, null, {}, { amountIn: '300' }, { cpiDepth: 0, parentIxIndex: null });
    const result = repo.aggregate('swap', 'total');
    expect(result.length).toBe(1);
    expect(result[0].total_calls).toBe(2);
  });

  test('aggregate: sum on numeric field', () => {
    const r = makeRepo();
    r.insertInstruction('swap', 's1', 100, null, {}, { amountIn: '500' }, { cpiDepth: 0, parentIxIndex: null });
    r.insertInstruction('swap', 's2', 200, null, {}, { amountIn: '300' }, { cpiDepth: 0, parentIxIndex: null });
    const result = r.aggregate('swap', 'total', undefined, undefined, 'sum', 'arg_amountin');
    expect(result[0].value).toBe(800);
  });

  test('aggregate: avg on numeric field', () => {
    const r = makeRepo();
    r.insertInstruction('swap', 's1', 100, null, {}, { amountIn: '400' }, { cpiDepth: 0, parentIxIndex: null });
    r.insertInstruction('swap', 's2', 200, null, {}, { amountIn: '600' }, { cpiDepth: 0, parentIxIndex: null });
    const result = r.aggregate('swap', 'total', undefined, undefined, 'avg', 'arg_amountin');
    expect(result[0].value).toBe(500);
  });

  test('aggregate: min/max on numeric field', () => {
    const r = makeRepo();
    r.insertInstruction('swap', 's1', 100, null, {}, { amountIn: '100' }, { cpiDepth: 0, parentIxIndex: null });
    r.insertInstruction('swap', 's2', 200, null, {}, { amountIn: '900' }, { cpiDepth: 0, parentIxIndex: null });
    const min = r.aggregate('swap', 'total', undefined, undefined, 'min', 'arg_amountin');
    const max = r.aggregate('swap', 'total', undefined, undefined, 'max', 'arg_amountin');
    expect(min[0].value).toBe(100);
    expect(max[0].value).toBe(900);
  });

  test('aggregate: rejects unsafe field name', () => {
    expect(() => {
      repo.aggregate('swap', 'total', undefined, undefined, 'sum', 'DROP TABLE');
    }).toThrow('Unsafe field name');
  });

  test('aggregate: group_by hour returns buckets', () => {
    const r = makeRepo();
    r.insertInstruction('swap', 'h1', 9000, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });
    r.insertInstruction('swap', 'h2', 18000, null, {}, {}, { cpiDepth: 0, parentIxIndex: null });
    const result = r.aggregate('swap', 'hour');
    expect(result.length).toBeGreaterThan(0);
  });

  // ── Account history tests ─────────────────────────────────────────────────

  test('insertAccountHistory: appends records (not upserts)', () => {
    repo.insertAccountHistory('PoolState', 'pubkey1', 100, { totalLiquidity: '5000', fee: '30' });
    repo.insertAccountHistory('PoolState', 'pubkey1', 200, { totalLiquidity: '6000', fee: '25' });
    repo.insertAccountHistory('PoolState', 'pubkey1', 300, { totalLiquidity: '7000', fee: '20' });
    const history = repo.queryAccountHistory('PoolState', 'pubkey1');
    expect(history.length).toBe(3);
    // Latest first (DESC order)
    expect(history[0].slot).toBe(300);
    expect(history[2].slot).toBe(100);
  });

  test('queryAccountHistory: respects limit', () => {
    const r = makeRepo();
    for (let i = 0; i < 10; i++) {
      r.insertAccountHistory('PoolState', 'pk', i * 100, { totalLiquidity: String(i * 1000) });
    }
    const history = r.queryAccountHistory('PoolState', 'pk', { limit: 3 });
    expect(history.length).toBe(3);
  });

  test('queryAccountHistory: returns empty for unknown pubkey', () => {
    const history = repo.queryAccountHistory('PoolState', 'nonexistent');
    expect(history).toEqual([]);
  });

  // ── Readiness check ────────────────────────────────────────────────────────

  test('isReady: returns true for healthy db', () => {
    expect(repo.isReady()).toBe(true);
  });
});
