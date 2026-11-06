import type { Candle } from "./candleTypes";
import { SNAPSHOT_TIMEFRAMES, TIER_CONFIG, STALE_MULTIPLIER, type Tier } from "./snapshotConfig";
import { isForexMarketClosed } from "../lib/marketHours";
export interface AnalysisInput { pair: string; tier: string; fetched_at: string; candles: Record<string, Candle[]>; }

// Yahoo occasionally reports daily FX high/low a few ticks inside the open
// or close. Repair only small boundary inconsistencies in the analysis COPY.
// The original handoff/candle-cache rows are never mutated or rewritten.
// Both limits must pass: <=0.1% of price AND <=15% of the quoted bar range.
function normalizeMinorDailyFxBoundary(candle: Candle): Candle {
  const { open, high, low, close } = candle;
  if (![open, high, low, close].every(Number.isFinite)
      || Math.min(open, high, low, close) <= 0 || high <= low) return candle;
  const correctedHigh = Math.max(open, high, close);
  const correctedLow = Math.min(open, low, close);
  const excess = Math.max(correctedHigh - high, low - correctedLow);
  if (excess === 0) return candle;
  if (excess > Math.max(open, close) * 0.001 || excess > (high - low) * 0.15) return candle;
  return { ...candle, high: correctedHigh, low: correctedLow };
}

export function validateAnalysisInputMetadata(input: AnalysisInput | null, pair: string, tier: Tier, now = Date.now()): asserts input is AnalysisInput {
  if (!input || input.pair !== pair || input.tier !== tier) throw new Error("Missing or mismatched saved input");
  const fetchedAt = Date.parse(input.fetched_at);
  const maxAge = TIER_CONFIG[tier].refreshMinutes * STALE_MULTIPLIER * 60_000;
  if (!Number.isFinite(fetchedAt) || fetchedAt > now + 60_000 || now - fetchedAt > maxAge)
    throw new Error("Saved input is stale or has an invalid fetch timestamp");
}

export function validateAnalysisInput(input: AnalysisInput | null, pair: string, tier: Tier, now = Date.now()) {
  validateAnalysisInputMetadata(input, pair, tier, now);
  const maxAge = TIER_CONFIG[tier].refreshMinutes * STALE_MULTIPLIER * 60_000;
  const windows: Record<string, Candle[]> = {};
  for (const tf of SNAPSHOT_TIMEFRAMES) {
    const candles = input.candles?.[tf];
    const limit = tf === "1d" ? 400 : 250;
    if (!Array.isArray(candles) || candles.length < 20 || candles.length > limit)
      throw new Error(`Invalid saved candle window: ${tf}`);
    let previous = -Infinity;
    let repairs = 0;
    const validated: Candle[] = [];
    // Restrict normalization to daily spot-FX inputs; metals and all shorter
    // timeframes continue to use the exact original strict OHLC validation.
    const isDailyFx = tf === "1d" && /^[A-Z]{6}$/.test(pair)
      && !pair.startsWith("XAU") && !pair.startsWith("XAG");
    const rejectCandle = (index: number, candle: Candle | null | undefined, reason: string): never => {
      const timestamp = Number.isFinite(candle?.timestamp)
        ? String(candle!.timestamp)
        : String(candle?.timestamp ?? "missing");
      throw new Error(
        `Malformed or unordered saved candles: ${pair} ${tf} index=${index} timestamp=${timestamp} reason=${reason}`
      );
    };
    for (let index = 0; index < candles.length; index++) {
      const original = candles[index];
      if (!original || typeof original !== "object")
        rejectCandle(index, original, "candle is missing or not an object");
      const candle = isDailyFx ? normalizeMinorDailyFxBoundary(original) : original;
      if (![candle.timestamp, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
        rejectCandle(index, candle, "timestamp or OHLC contains a non-finite value");
      if (Math.min(candle.open, candle.high, candle.low, candle.close) <= 0)
        rejectCandle(index, candle, "OHLC contains a non-positive price");
      if (candle.high < Math.max(candle.open, candle.close, candle.low))
        rejectCandle(index, candle, "high is below open, close, or low");
      if (candle.low > Math.min(candle.open, candle.close))
        rejectCandle(index, candle, "low is above open or close");
      if (candle.timestamp <= previous)
        rejectCandle(index, candle, "timestamps are duplicate or not strictly ascending");
      if (candle.timestamp * 1000 > now + 300_000)
        rejectCandle(index, candle, "timestamp is more than five minutes in the future");
      if (candle !== original) repairs++;
      previous = candle.timestamp;
      validated.push(candle);
    }
    if (repairs) console.warn("[analysis-daily-ohlc-normalized]", { pair, correctedBars: repairs });
    // Provider data can be stale even when a download just completed. A full
    // weekend is exempt because Friday candles are the latest legitimate bars.
    const seconds = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[tf];
    if (!isForexMarketClosed(new Date(now)) && now - previous * 1000 > seconds * 1000 + maxAge)
      throw new Error(`Provider candles are stale: ${tf}`);
    // Preserve original arrays (and indicator output) for unchanged windows.
    windows[tf] = repairs ? validated : candles;
  }
  return windows;
}

