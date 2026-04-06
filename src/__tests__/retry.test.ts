import { withRetry, sleep } from '../utils/retry';

describe('withRetry', () => {
  test('returns result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on failure and succeeds', async () => {
    let calls = 0;
    const fn = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'success';
    });
    const result = await withRetry(fn, { maxAttempts: 5, initialDelayMs: 1 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('throws after max attempts', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));
    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 1 })
    ).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('respects maxAttempts=1 (no retry)', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fail'));
    await expect(
      withRetry(fn, { maxAttempts: 1, initialDelayMs: 1 })
    ).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('sleep', () => {
  test('resolves after delay', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});
