import { logger } from '../observability/logger';

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean; // full jitter (recommended for RPC)
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const initialDelayMs = opts.initialDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 30000;
  const factor = opts.factor ?? 2;
  const jitter = opts.jitter ?? true; // enabled by default

  let attempt = 0;
  let baseDelay = initialDelayMs;

  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      if (attempt >= maxAttempts) throw err;

      // Full jitter: random in [0, min(cap, base)]
      const cappedDelay = Math.min(baseDelay, maxDelayMs);
      const delay = jitter
        ? Math.floor(Math.random() * cappedDelay)
        : cappedDelay;

      logger.warn('Retrying after error', {
        attempt,
        maxAttempts,
        delayMs: delay,
        error: err.message,
      });

      await sleep(delay);
      baseDelay = Math.min(baseDelay * factor, maxDelayMs);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
