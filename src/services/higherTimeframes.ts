import type { Candle } from "./candleTypes";
import { computeIndicators, type IndicatorReport } from "./marketAnalyzer";

export type HigherTimeframe = "1w" | "1mo";
export type HigherTimeframeCandle = Candle & {
  complete: boolean;
  periodEnd: number;
  dailyCount: number;
};

export type DerivedHigherTimeframeSummary = {
  timeframe: HigherTimeframe;
  derivedFrom: "1d";
  closedCandles: number;
  latestClosedPeriodStart: string;
  lastClose: number;
  lastClosed: { open: number; high: number; low: number; close: number };
  direction: "Bullish" | "Bearish" | "Flat";
  supportCandidate: number | null;
  resistanceCandidate: number | null;
  indicators: Partial<IndicatorReport>;
  indicatorHistorySufficient: boolean;
  note: string;
};

function periodStart(timestamp: number, timeframe: HigherTimeframe): number {
  const date = new Date(timestamp * 1000);
  if (timeframe === "1mo") {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
  }
  const day = date.getUTCDay();
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - ((day + 6) % 7),
  ) / 1000;
}

function nextPeriod(start: number, timeframe: HigherTimeframe): number {
  if (timeframe === "1w") return start + 7 * 86400;
  const date = new Date(start * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000;
}

function valid(candle: Candle): boolean {
  return Number.isSafeInteger(candle.timestamp) && candle.timestamp > 0
    && [candle.open, candle.high, candle.low, candle.close]
      .every(value => Number.isFinite(value) && value > 0)
    && candle.low <= Math.min(candle.open, candle.close)
    && candle.high >= Math.max(candle.open, candle.close)
    && (candle.volume === undefined
      || (Number.isFinite(candle.volume) && candle.volume >= 0));
}

/**
 * Build calendar-aligned weekly/monthly OHLC from saved daily candles.
 * No provider calls, invented sessions, or database writes are performed.
 * Weeks start Monday UTC; months start on the first UTC calendar day.
 */
export function aggregateDailyCandles(
  daily: readonly Candle[],
  timeframe: HigherTimeframe,
  nowMs = Date.now(),
): HigherTimeframeCandle[] {
  const byTimestamp = new Map<number, Candle>();
  for (const candle of daily) {
    if (valid(candle) && candle.timestamp * 1000 <= nowMs + 60_000) {
      byTimestamp.set(candle.timestamp, candle);
    }
  }

  const sorted = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  const grouped = new Map<number, HigherTimeframeCandle>();

  for (const candle of sorted) {
    const start = periodStart(candle.timestamp, timeframe);
    const end = nextPeriod(start, timeframe);
    const existing = grouped.get(start);

    if (!existing) {
      grouped.set(start, {
        timestamp: start,
        periodEnd: end,
        complete: end * 1000 <= nowMs,
        dailyCount: 1,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        ...(candle.volume === undefined ? {} : { volume: candle.volume }),
      });
      continue;
    }

    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.dailyCount++;
    if (candle.volume !== undefined) {
      existing.volume = (existing.volume ?? 0) + candle.volume;
    }
  }

  return [...grouped.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Indicators are deliberately withheld until 35 completed higher-timeframe
 * candles exist. OHLC/direction context remains available before that point.
 */
export function summarizeHigherTimeframe(
  daily: readonly Candle[],
  timeframe: HigherTimeframe,
  now = Date.now(),
): DerivedHigherTimeframeSummary | null {
  const closed = aggregateDailyCandles(daily, timeframe, now)
    .filter(candle => candle.complete);
  const last = closed.at(-1);
  if (!last) return null;

  const recent = closed.slice(-8);
  const enough = closed.length >= 35;
  const fullIndicators = enough ? computeIndicators(closed) : null;
  const indicators: Partial<IndicatorReport> = fullIndicators ? {
    rsi: fullIndicators.rsi,
    ema_20: fullIndicators.ema_20,
    macd: fullIndicators.macd,
    macd_signal: fullIndicators.macd_signal,
    macd_trend: fullIndicators.macd_trend,
    atr: fullIndicators.atr,
    support_levels_all: fullIndicators.support_levels_all,
    resistance_levels_all: fullIndicators.resistance_levels_all,
  } : {};

  return {
    timeframe,
    derivedFrom: "1d",
    closedCandles: closed.length,
    latestClosedPeriodStart: new Date(last.timestamp * 1000).toISOString(),
    lastClose: last.close,
    lastClosed: {
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
    },
    direction: last.close > last.open
      ? "Bullish"
      : last.close < last.open ? "Bearish" : "Flat",
    supportCandidate: recent.length >= 3
      ? Math.min(...recent.map(candle => candle.low)) : null,
    resistanceCandidate: recent.length >= 3
      ? Math.max(...recent.map(candle => candle.high)) : null,
    indicators,
    indicatorHistorySufficient: enough,
    note: enough
      ? "Closed higher-timeframe candles only. Support/resistance are observed range candidates, not confirmed trade levels."
      : "Insufficient completed higher-timeframe history for reliable momentum indicators. No RSI, EMA, MACD or ATR is inferred.",
  };
}

/** Calendar-week compatibility summary for the existing weekly_trend field. */
export function computeWeeklyTrend(daily: readonly Candle[], now = Date.now()) {
  const weeks = aggregateDailyCandles(daily, "1w", now).map(candle => ({
    weekStart: new Date(candle.timestamp * 1000).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    direction: (candle.close > candle.open
      ? "up" : candle.close < candle.open ? "down" : "flat") as "up" | "down" | "flat",
    complete: candle.complete,
  }));

  const completed = weeks.filter(week => week.complete);
  let streak = 0;
  const streakDirection = completed.at(-1)?.direction ?? null;
  for (let index = completed.length - 1;
    index >= 0 && completed[index].direction === streakDirection;
    index--) streak++;

  const recentWeeks = completed.slice(-8);
  return {
    weeks,
    weekCount: completed.length,
    streak,
    streakDirection,
    recentSummary: {
      lastNWeeks: recentWeeks.length,
      up: recentWeeks.filter(week => week.direction === "up").length,
      down: recentWeeks.filter(week => week.direction === "down").length,
    },
  };
}
