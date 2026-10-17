// src/services/snapshotService.ts

import { fetchHistoricalOHLCV, fetchOHLCV, Candle } from "./marketData";
import { predictTrade, PredictionResult } from "./aiPredictor";
import { computeIndicators, IndicatorReport } from "./marketAnalyzer";
import { getPdBias, isKillzoneActive, detectStructure, detectLiquidity } from "./smcAnalysis";
import { toAnalysisSwingPoints, splitSwings, summarizeMarketStructure } from "./structureBridge";
import { detectChartPatterns } from "./chartPatterns";
import { MarketStructure, PatternSet } from "./analysisTypes";
import {
  SNAPSHOT_TIMEFRAMES,
  ANCHOR_INTERVAL,
  TIER_CONFIG,
  Tier,
} from "./snapshotConfig";

import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { checkAlertsForPair } from "./alertService";
import { dropOffGridCandles, mergeCandleHistory, mergeDailyByUtcDate, resampleHourlyToDaily, trimIntradayHistory } from "../lib/candleCacheMerge";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PairSnapshotOutcome {
  pair: string;
  ok: boolean;
  error?: string;
}

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

  const analysisSwings = toAnalysisSwingPoints(candles, rawStructure.swings);
  const { highs, lows } = splitSwings(analysisSwings);
  const patterns = detectChartPatterns(highs, lows);

  return { structure, patterns };
}

export async function runSnapshotForPair(
  pair: string,
  tier: Tier
): Promise<PairSnapshotOutcome> {
  const supabase = getSupabaseAdmin();

  // Process CPU deltas include concurrent requests sharing this Node process.
  // Wall time includes network waits; neither value is per-request billing.
  let stageCpu = process.cpuUsage();
  let stageWall = performance.now();
  const markStage = (stage: string) => {
    const cpu = process.cpuUsage(stageCpu);
    console.info("[snapshot-cpu]", JSON.stringify({ pair, tier, stage,
      processCpuMs: (cpu.user + cpu.system) / 1000,
      wallMs: Math.round(performance.now() - stageWall) }));
    stageCpu = process.cpuUsage();
    stageWall = performance.now();
  };

  try {
    // Grab the price this pair had BEFORE this run overwrites it — alert
    // crossing detection needs the previous tick to catch a threshold
    // crossed between two snapshots, not just an exact-match price.
    const { data: prevRow } = await supabase
      .from("market_snapshots")
      .select("live_price")
      .eq("pair", pair)
      .maybeSingle();
    const prevPrice = prevRow?.live_price != null ? Number(prevRow.live_price) : null;

    const multiTfCandles: Record<string, Candle[]> = {};
    for (const tf of SNAPSHOT_TIMEFRAMES) {
      const limit = tf === "1d" ? 400 : 250;
      multiTfCandles[tf] = await fetchOHLCV(pair, tf, limit);
      await sleep(150);
    }

    markStage("read-price-and-fetch-candles");
    const anchorCandles = multiTfCandles[ANCHOR_INTERVAL];
    if (!anchorCandles || anchorCandles.length < 20) {
      throw new Error(`Insufficient ${ANCHOR_INTERVAL} candles for ${pair}`);
    }

    // Merge the fresh Yahoo windows into the existing cache instead of
    // replacing history on every refresh. Cache reads are fail-safe: if an
    // existing row cannot be read, skip that cache write rather than risking
    // history loss with a blind overwrite.
    const candleFetchedAt = new Date().toISOString();
    const intradayTimeframes = SNAPSHOT_TIMEFRAMES.filter((tf) => tf !== "1d");
    let mergedHourlyForDailyRepair: Candle[] = [];

    const { data: existingIntradayRows, error: existingIntradayError } = await supabase
      .from("market_candle_cache")
      .select("timeframe,candles,history_backfilled_at")
      .eq("pair", pair)
      .in("timeframe", intradayTimeframes);

    if (existingIntradayError) {
      console.error(
        `[candle-cache] Could not read existing ${pair} intraday history; preserving current cache:`,
        existingIntradayError.message
      );
    } else {
      const existingByTimeframe = new Map(
        (existingIntradayRows ?? []).map((row: any) => [String(row.timeframe), row] as const)
      );

      // Spread the one-time history work across normal cron runs: at most one
      // wider Yahoo request per pair per snapshot. Once a timeframe succeeds,
      // history_backfilled_at prevents it from being fetched again.
      const backfillTimeframe = intradayTimeframes.find((tf) => {
        const row = existingByTimeframe.get(tf) as any;
        return !row?.history_backfilled_at;
      });
      const historicalByTimeframe = new Map<string, Candle[]>();
      let completedBackfillTimeframe: string | null = null;

      if (backfillTimeframe) {
        try {
          const history = await fetchHistoricalOHLCV(
            pair,
            backfillTimeframe as '15m' | '1h' | '4h'
          );
          if (history.length) {
            historicalByTimeframe.set(backfillTimeframe, history);
            completedBackfillTimeframe = backfillTimeframe;
          }
        } catch (backfillError: any) {
          console.warn(
            `[candle-backfill] ${pair} ${backfillTimeframe} history unavailable; will retry later:`,
            backfillError?.message || backfillError
          );
        }
      }

      const intradayRows = intradayTimeframes.flatMap((tf) => {
        // Yahoo can append a synthetic current-price bar with an off-grid
        // timestamp. Never persist those as real candles.
        const incoming = dropOffGridCandles(
          multiTfCandles[tf] || [],
          tf as '15m' | '1h' | '4h'
        );
        if (!incoming.length) return [];

        const existingRow = existingByTimeframe.get(tf) as any;
        const incomingWithHistory = mergeCandleHistory(
          incoming,
          dropOffGridCandles(
            historicalByTimeframe.get(tf) ?? [],
            tf as '15m' | '1h' | '4h'
          )
        );
        // Re-filter the merged cache too, which self-heals any stub bars that
        // were written before this fix.
        const candles = trimIntradayHistory(
          dropOffGridCandles(
            mergeCandleHistory(existingRow?.candles, incomingWithHistory),
            tf as '15m' | '1h' | '4h'
          ),
          tf as '15m' | '1h' | '4h'
        );
        if (tf === '1h') mergedHourlyForDailyRepair = candles;
        const sourceCandle = incoming.at(-1);

        return [{
          pair,
          timeframe: tf,
          tier,
          candles,
          candle_count: candles.length,
          source_candle_at: sourceCandle?.timestamp
            ? new Date(sourceCandle.timestamp * 1000).toISOString()
            : null,
          fetched_at: candleFetchedAt,
          history_backfilled_at:
            completedBackfillTimeframe === tf
              ? candleFetchedAt
              : existingRow?.history_backfilled_at ?? null,
        }];
      });

      if (intradayRows.length) {
        const { error: candleCacheError } = await supabase
          .from("market_candle_cache")
          .upsert(intradayRows, { onConflict: "pair,timeframe" });

        if (candleCacheError) {
          console.error(
            `[candle-cache] Failed to persist merged ${pair} intraday candles:`,
            candleCacheError.message
          );
        }
      }
    }

    const nativeDailyCandles = multiTfCandles["1d"] || [];
    const repairDailyFromHourly =
      ['PLTUM', 'PALDM', 'XAGUSD'].includes(pair) &&
      mergedHourlyForDailyRepair.length > 0;
    const dailyCandlesForCache = repairDailyFromHourly
      ? resampleHourlyToDaily(mergedHourlyForDailyRepair)
      : nativeDailyCandles;
    if (dailyCandlesForCache.length) {
      const { data: existingDailyRow, error: existingDailyError } = await supabase
        .from("long_range_candle_cache")
        .select("candles")
        .eq("pair", pair)
        .eq("range_key", "1y")
        .maybeSingle();

      if (existingDailyError) {
        console.error(
          `[long-range-cache] Could not read existing ${pair} daily history; preserving current cache:`,
          existingDailyError.message
        );
      } else {
        const mergedDailyCandles = repairDailyFromHourly
          ? mergeDailyByUtcDate(existingDailyRow?.candles, dailyCandlesForCache)
          : mergeCandleHistory(existingDailyRow?.candles, dailyCandlesForCache);

        const { error: dailyCacheError } = await supabase
          .from("long_range_candle_cache")
          .upsert(
            {
              pair,
              range_key: "1y",
              candles: mergedDailyCandles,
              fetched_at: candleFetchedAt,
            },
            { onConflict: "pair,range_key" }
          );

        if (dailyCacheError) {
          console.error(
            `[long-range-cache] Failed to persist merged ${pair} daily candles:`,
            dailyCacheError.message
          );
        }
      }
    }

    markStage("merge-and-save-candle-history");
    const multiTfSummary: Record<
      string,
      { indicators: Partial<IndicatorReport>; lastClose: number | null }
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

    markStage("indicators-smc-patterns-and-setups");
    const { error } = await supabase.from("market_snapshots").upsert(
      {
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
      },
      { onConflict: "pair" }
    );

    if (error) throw error;

    // No external price feed — evaluate price_alerts against the snapshot
    // price we just wrote, using prevPrice (fetched above) as the reference
    // point for crossing detection. Never let an alert-side failure fail
    // the snapshot write itself.
    try {
      await checkAlertsForPair(pair, result.live_price ?? null, prevPrice);
    } catch (alertErr: any) {
      console.error(`[alertService] check failed for ${pair}:`, alertErr?.message || alertErr);
    }

    markStage("save-snapshot-and-check-alerts");
    return { pair, ok: true };
  } catch (err: any) {
    console.error(`❌ Snapshot failed for ${pair}:`, err?.message || err);

    await supabase
      .from("market_snapshots")
      .update({ is_stale: true, last_error: String(err?.message || err) })
      .eq("pair", pair);

    return { pair, ok: false, error: String(err?.message || err) };
  }
}

export async function runSnapshotBatch(tier: Tier) {
  const { pairs, staggerMs } = TIER_CONFIG[tier];
  const results: PairSnapshotOutcome[] = [];

  for (const pair of pairs) {
    const outcome = await runSnapshotForPair(pair, tier);
    results.push(outcome);
    await sleep(staggerMs);
  }

  return {
    tier,
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok),
  };
}
