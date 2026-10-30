import type { Candle } from "./candleTypes";
import { predictTrade, PredictionResult } from "./aiPredictor";
import { computeIndicators, IndicatorReport } from "./marketAnalyzer";
import { getPdBias, isKillzoneActive, detectStructure, detectLiquidity } from "./smcAnalysis";
import { toAnalysisSwingPoints, splitSwings, summarizeMarketStructure } from "./structureBridge";
import { CHART_PATTERN_VERSION, detectChartPatterns } from "./chartPatterns";
import type { MarketStructure, PatternSet } from "./analysisTypes";
import { SNAPSHOT_TIMEFRAMES, ANCHOR_INTERVAL, type Tier } from "./snapshotConfig";

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
  candles: Candle[]
): { structure: MarketStructure; patterns: PatternSet } {
  const emptyStructure: MarketStructure = {
    bos: { detected: false, confidence: 0 },
    choch: { detected: false, confidence: 0 },
    equal_highs: { detected: false, confidence: 0 },
    equal_lows: { detected: false, confidence: 0 },
    liquidity_sweep: { detected: false, confidence: 0 },
  };
  const emptyPatterns = detectChartPatterns([], []); // all-false PatternSet

  if (!candles || candles.length < 20) {
    return { structure: emptyStructure, patterns: emptyPatterns };
  }

  const rawStructure = detectStructure(candles);
  const liquidity = detectLiquidity(candles);
  const structure = summarizeMarketStructure(candles, rawStructure, liquidity);

  // The saved bundle includes a forming candle; pattern validation uses closed bars only.
  const patternCandles = candles.slice(0, -1);
  const patternStructure = detectStructure(patternCandles);
  const analysisSwings = toAnalysisSwingPoints(patternCandles, patternStructure.swings);
  const { highs, lows } = splitSwings(analysisSwings);
  const patterns = detectChartPatterns(highs, lows, patternCandles);

  return { structure, patterns };
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

    for (const tf of SNAPSHOT_TIMEFRAMES) {
      const candles = multiTfCandles[tf];
      const indicators = candles?.length ? computeIndicators(candles) : {};
      indicatorCache[tf] = indicators;
      multiTfSummary[tf] = {
        indicators,
        lastClose: candles?.length ? candles[candles.length - 1].close : null,
      };

      const { structure, patterns } = analyzeTimeframeStructureAndPatterns(candles);
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
    });

    // Kept as-is for backward compatibility with anything already reading
    // this field (e.g. existing chat/route.ts usage) — counts only, from
    // the anchor timeframe. structureByTf above is the new, richer,
    // per-timeframe, confidence-scored version.
    const anchorClosed = anchorCandles.slice(0, -1);
    const legacyStructure = detectStructure(anchorClosed);
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
            : await predictTrade(multiTfCandles, pair, tf, { skipAi: true, indicatorCache });
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

