import type { Candle } from "./candleTypes";
import { SNAPSHOT_TIMEFRAMES, TIER_CONFIG, STALE_MULTIPLIER, type Tier } from "./snapshotConfig";
import { isForexMarketClosed } from "../lib/marketHours";
export interface AnalysisInput { pair: string; tier: string; fetched_at: string; candles: Record<string, Candle[]>; }
export function validateAnalysisInput(input: AnalysisInput | null, pair: string, tier: Tier, now = Date.now()) {
  if (!input || input.pair !== pair || input.tier !== tier) throw new Error("Missing or mismatched saved input");
  const fetchedAt = Date.parse(input.fetched_at);
  const maxAge = TIER_CONFIG[tier].refreshMinutes * STALE_MULTIPLIER * 60_000;
  if (!Number.isFinite(fetchedAt) || fetchedAt > now + 60_000 || now - fetchedAt > maxAge)
    throw new Error("Saved input is stale or has an invalid fetch timestamp");
  const windows: Record<string, Candle[]> = {};
  for (const tf of SNAPSHOT_TIMEFRAMES) {
    const candles = input.candles?.[tf];
    const limit = tf === "1d" ? 400 : 250;
    if (!Array.isArray(candles) || candles.length < 20 || candles.length > limit)
      throw new Error(`Invalid saved candle window: ${tf}`);
    let previous = -Infinity;
    for (const candle of candles) {
      if (![candle.timestamp, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
          || Math.min(candle.open, candle.high, candle.low, candle.close) <= 0
          || candle.high < Math.max(candle.open, candle.close, candle.low)
          || candle.low > Math.min(candle.open, candle.close)
          || candle.timestamp <= previous || candle.timestamp * 1000 > now + 300_000)
        throw new Error(`Malformed or unordered saved candles: ${tf}`);
      previous = candle.timestamp;
    }
    // Provider data can be stale even when a download just completed. A full
    // weekend is exempt because Friday candles are the latest legitimate bars.
    const seconds = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[tf];
    if (!isForexMarketClosed(new Date(now)) && now - previous * 1000 > seconds * 1000 + maxAge)
      throw new Error(`Provider candles are stale: ${tf}`);
    windows[tf] = candles;
  }
  return windows;
}
