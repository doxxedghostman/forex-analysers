import { createHash } from 'node:crypto';
import type { Candle } from './candleTypes';

// Best-effort warm-instance reuse only. All correctness/version checks remain
// outside this cache. Every timestamp and OHLCV value participates in the key,
// including historical corrections and the current forming candle.
export function createCandleCalculationCache<T>(capacity = 160) {
  const entries = new Map<string, { fingerprint: string; value: T }>();
  return (key: string, candles: Candle[], calculate: () => T): T => {
    const hash = createHash('sha256');
    for (const c of candles) {
      hash.update(JSON.stringify([c.timestamp, c.open, c.high, c.low, c.close, c.volume ?? 0]) + '\n');
    }
    const fingerprint = hash.digest('hex');
    const cached = entries.get(key);
    if (cached?.fingerprint === fingerprint) {
      entries.delete(key);
      entries.set(key, cached);
      return structuredClone(cached.value);
    }
    const value = calculate();
    entries.delete(key);
    entries.set(key, { fingerprint, value: structuredClone(value) });
    if (entries.size > capacity) entries.delete(entries.keys().next().value!);
    return value;
  };
}
