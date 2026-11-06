import type { Candle } from "./candleTypes";
import { predictTrade, PredictionResult, type ClosedStructureContext } from "./aiPredictor";
import { computeIndicators, IndicatorReport } from "./marketAnalyzer";
import { getPdBias, isKillzoneActive, detectStructure, detectLiquidity } from "./smcAnalysis";
import { toAnalysisSwingPoints, splitSwings, summarizeMarketStructure } from "./structureBridge";
import { CHART_PATTERN_VERSION, detectChartPatterns } from "./chartPatterns";
import type { MarketStructure, PatternSet } from "./analysisTypes";
import { SNAPSHOT_TIMEFRAMES, ANCHOR_INTERVAL, type Tier } from "./snapshotConfig";
import { createCandleCalculationCache } from './candleCalculationCache';

interface WeeklyBucket {
  weekStart: string;
  open: number;
  high: number;
  low: number;
  close: number;
  direction: "up" | "down" | "flat";
}

/**
 * Groups daily candles into 5-candle (trading week) buckets and derives
 * a simple weekly trend summary — used so the AI can answer "what about
 * next week" style questions using real historical pattern instead of
 * failing on a nonexistent "1w" timeframe.
 */
function computeWeeklyTrend(dailyCandles: Candle[]) {
  const buckets: WeeklyBucket[] = [];
  for (let i = 0; i < dailyCandles.length; i += 5) {
    const chunk = dailyCandles.slice(i, i + 5);
    if (chunk.length === 0) continue;

    const open = chunk[0].open;
    const close = chunk[chunk.length - 1].close;
    const high = Math.max(...chunk.map((c) => c.high));
    const low = Math.min(...chunk.map((c) => c.low));
    const direction: WeeklyBucket["direction"] =
      close > open ? "up" : close < open ? "down" : "flat";

    buckets.push({
      weekStart: chunk[0].timestamp ? String(chunk[0].timestamp) : "",
      open,
      high,
      low,
      close,
      direction,
    });
  }

  // Streak = how many of the most recent weeks moved the same direction
  let streak = 0;
  let streakDirection: WeeklyBucket["direction"] | null = null;
  for (let i = buckets.length - 1; i >= 0; i--) {
    const dir = buckets[i].direction;
    if (streakDirection === null) {
      streakDirection = dir;
      streak = 1;
    } else if (dir === streakDirection) {
      streak++;
    } else {
      break;
    }
  }

  const recentWeeks = buckets.slice(-8); // last ~8 weeks for context
  const upCount = recentWeeks.filter((w) => w.direction === "up").length;
  const downCount = recentWeeks.filter((w) => w.direction === "down").length;

  return {
    weeks: buckets,
    weekCount: buckets.length,
    streak,
    streakDirection,
    recentSummary: {
      lastNWeeks: recentWeeks.length,
      up: upCount,
      down: downCount,
    },
  };
}

/**
 * Runs smcAnalysis structure/liquidity detection + chartPatterns geometry
 * detection for ONE timeframe's candles, and returns both in the shape the
 * scan payload / AI prompt expects. Kept as its own function since this now
 * runs once per timeframe (previously structure was only computed for the
 * anchor interval).
 */
function analyzeTimeframeStructureAndPatterns(
  candles: Candle[], closedOnly = false
): { structure: MarketStructure; patterns: PatternSet; closedContext: ClosedStructureContext } {
  const emptyStructure: MarketStructure = {
    bos: { detected: false, confidence: 0 },
    choch: { detected: false, confidence: 0 },
    equal_highs: { detected: false, confidence: 0 },
    equal_lows: { detected: false, confidence: 0 },
    liquidity_sweep: { detected: false, confidence: 0 },
  };
  const emptyPatterns = detectChartPatterns([], []); // all-false PatternSet

  if (!candles || candles.length < 20) {
    return { structure: emptyStructure, patterns: emptyPatterns,
      closedContext: { candles: [], structure: detectStructure([]), liquidity: [] } };
  }

  const rawStructure = detectStructure(candles);
  const liquidity = detectLiquidity(candles);
  const structure = summarizeMarketStructure(candles, rawStructure, liquidity);

  // The saved bundle includes a forming candle; pattern validation uses closed bars only.
  const patternCandles = closedOnly ? candles : candles.slice(0, -1);
  const patternStructure = closedOnly ? rawStructure : detectStructure(patternCandles);
  const analysisSwings = toAnalysisSwingPoints(patternCandles, patternStructure.swings);
  const { highs, lows } = splitSwings(analysisSwings);
  const patterns = detectChartPatterns(highs, lows, patternCandles);

  return { structure, patterns, closedContext: { candles: patternCandles,
    structure: patternStructure, liquidity: closedOnly ? liquidity : detectLiquidity(patternCandles) } };
}

type FrameCalculation = ReturnType<typeof analyzeTimeframeStructureAndPatterns> & {
  indicators: Partial<IndicatorReport>;
};
const cachedFrame = createCandleCalculationCache<FrameCalculation>();
function calculateFrame(pair: string, tf: string, candles: Candle[], closedOnly = false) {
  return cachedFrame(`${pair}:${tf}:${closedOnly ? 'closed' : 'forming'}:patterns-${CHART_PATTERN_VERSION}`,
    candles ?? [], () => ({
      indicators: candles?.length ? computeIndicators(candles) : {},
      ...analyzeTimeframeStructureAndPatterns(candles, closedOnly),
    }));
}

export async function computeSnapshot(pair: string, tier: Tier, multiTfCandles: Record<string, Candle[]>) {
  const anchorCandles = multiTfCandles[ANCHOR_INTERVAL];
    const multiTfSummary: Record<
      string,
      { indicators: Partial<IndicatorReport>; lastClose: number | null; patternVersion?: number }
    > = {};
    // NEW: per-timeframe structure (BOS/CHoCH/equal highs/lows/sweep) and
    // chart patterns (double top/bottom, H&S) — previously structure was
    // only computed once, for the anchor timeframe.
    const structureByTf: Record<string, MarketStructure> = {};
    const patternsByTf: Record<string, PatternSet> = {};

    // Shared across the summary loop below AND every predictTrade() call for
    // this pair, keyed by normalized timeframe ("15m"/"1h"/"4h"/"1d") — same
    // keys predictTrade's internal prepareMarketContext() uses. Populating it
    // here (instead of after this loop, as before) means computeIndicators()
    // runs ONCE per timeframe per pair instead of twice: once for
    // multiTfSummary and again inside the first predictTrade() call. That
    // second computation was pure waste — same candles, same result,
    // recomputed from scratch every 5-20 min for every pair.
    const indicatorCache: Record<string, any> = {};
    const structureCache: Record<string, ClosedStructureContext> = {};

    for (const tf of SNAPSHOT_TIMEFRAMES) {
      const candles = multiTfCandles[tf];
      const { indicators, structure, patterns, closedContext } = calculateFrame(pair, tf, candles);
      indicatorCache[tf] = indicators;
      structureCache[tf] = closedContext;
      multiTfSummary[tf] = {
        indicators,
        lastClose: candles?.length ? candles[candles.length - 1].close : null,
      };

      structureByTf[tf] = structure;
      patternsByTf[tf] = patterns;
      multiTfSummary[tf].patternVersion = CHART_PATTERN_VERSION;
    }

    const dailyCandles = multiTfCandles["1d"];
    const weeklyTrend = dailyCandles?.length
      ? computeWeeklyTrend(dailyCandles)
      : null;

    const result: PredictionResult = await predictTrade(multiTfCandles, pair, ANCHOR_INTERVAL, {
      skipAi: true,
      indicatorCache,
      structureCache,
    });

    // Kept as-is for backward compatibility with anything already reading
    // this field (e.g. existing chat/route.ts usage) — counts only, from
    // the anchor timeframe. structureByTf above is the new, richer,
    // per-timeframe, confidence-scored version.
    const anchorClosed = structureCache[ANCHOR_INTERVAL].candles;
    const legacyStructure = structureCache[ANCHOR_INTERVAL].structure;
    const smcSummary = {
      pd_bias: getPdBias(multiTfCandles["1d"] || anchorClosed, result.live_price ?? undefined),
      killzone: isKillzoneActive(),
      bos_count: legacyStructure.bos.length,
      choch_count: legacyStructure.choch.length,
      sweep_count: legacyStructure.sweeps.length,
    };

    // Map the generated setup prediction to all active snapshot timeframes
    // so chat/route.ts finds data regardless of which timeframe the user requests.
    const setupsMap: Record<string, PredictionResult> = {};
    for (const tf of SNAPSHOT_TIMEFRAMES) {
        setupsMap[tf] = tf === ANCHOR_INTERVAL
            ? result
            : await predictTrade(multiTfCandles, pair, tf, { skipAi: true, indicatorCache, structureCache });
    }


  return {
        pair,
        tier,
        anchor_interval: ANCHOR_INTERVAL,
        live_price: result.live_price,
        direction: result.direction,
        confidence_score: result.confidence_score,
        trade_strength: result.trade_strength,
        market_state: result.market_state,
        preferred: result.preferred,
        base_long: result.long_setup,
        base_short: result.short_setup,
        reasoning: result.reasoning,
        multi_tf: multiTfSummary,
        smc: smcSummary,
        structure_by_tf: structureByTf, // <-- NEW: confidence-scored structure per timeframe
        patterns_by_tf: patternsByTf,   // <-- NEW: chart patterns per timeframe
        setups: setupsMap,
        weekly_trend: weeklyTrend,
        is_stale: false,
        last_error: null,
        updated_at: new Date().toISOString(),
      };
}

/** Closed Deriv bars have their own cadence and never overwrite the 4H
 * recommendation, live quote, or longer-timeframe publication version. */
export async function computeShortTimeframeSnapshot(
  pair: string, candlesByTf: Record<string, Candle[]>,
  higherIndicators: Record<string, any> = {},
  contextCandles: Record<string, Candle[]> = candlesByTf,
) {
  const multiTf: Record<string, any> = {};
  const structure: Record<string, MarketStructure> = {};
  const patterns: Record<string, PatternSet> = {};
  const setups: Record<string, PredictionResult> = {};
  const indicatorCache: Record<string, any> = { ...higherIndicators };
  const structureCache: Record<string, ClosedStructureContext> = {};
  const frames = ['1m', '5m'].filter(tf => candlesByTf[tf]?.length);
  const allCandles = { ...contextCandles, ...candlesByTf };
  // An unchanged short frame still supplies the same alignment context to
  // the changed frame's setup; only its own structure/setup publication is skipped.
  for (const tf of ['1m', '5m']) {
    if (!frames.includes(tf) && allCandles[tf]?.length) {
      indicatorCache[tf] = calculateFrame(pair, tf, allCandles[tf], true).indicators;
    }
  }
  for (const tf of frames) {
    const candles = candlesByTf[tf];
    const found = calculateFrame(pair, tf, candles, true);
    const indicators = found.indicators;
    indicatorCache[tf] = indicators;
    structureCache[tf] = found.closedContext;
    multiTf[tf] = { indicators, lastClose: candles.at(-1)!.close, patternVersion: CHART_PATTERN_VERSION };
    structure[tf] = found.structure;
    patterns[tf] = found.patterns;
  }
  for (const tf of frames) {
    setups[tf] = await predictTrade(allCandles, pair, tf, {
      skipAi: true, indicatorCache, structureCache, candlesClosed: true,
    });
  }
  return { multi_tf: multiTf, structure_by_tf: structure, patterns_by_tf: patterns, setups };
}


