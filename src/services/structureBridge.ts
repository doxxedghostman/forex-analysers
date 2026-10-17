// structureBridge.ts
// Bridges smcAnalysis.ts (the real, already-in-production structure/liquidity
// detector) to two things the scan payload needs:
//   1. MarketStructure — the { detected, confidence, direction? } shape for
//      BOS/CHoCH/equal highs/equal lows/liquidity sweep, for the AI prompt.
//   2. analysisTypes.SwingPoint[] — the shape chartPatterns.ts consumes for
//      double top/bottom, H&S geometry detection.
//
// This is the ONLY place that translates smcAnalysis's event arrays into the
// confidence-scored payload shape — marketAnalyzer.ts does not duplicate any
// of this logic.

import {
  Candle,
  StructureResult,
  LiquidityZone,
  SwingPoint as SmcSwingPoint,
} from "./smcAnalysis";
import { DetectionResult, MarketStructure, SwingPoint } from "./analysisTypes";

const EMPTY: DetectionResult = { detected: false, confidence: 0 };

/** How many candles back from the end of the series an event still counts
 * as "current" for this timeframe's snapshot. Older events are historical
 * noise, not part of "what's happening right now". */
const RECENCY_WINDOW = 5;

function clampConfidence(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

/** Confidence decays with distance from the most recent candle — an event
 * on the last candle is much more actionable than one 5 candles back. */
function recencyConfidence(eventIdx: number, lastIdx: number, base = 90, floor = 50): number {
  const distance = lastIdx - eventIdx;
  if (distance < 0 || distance > RECENCY_WINDOW) return 0;
  const decay = (distance / RECENCY_WINDOW) * (base - floor);
  return Math.round(clampConfidence(base - decay));
}

/**
 * Converts smcAnalysis.ts's SwingPoint[] (idx/type:"swing_high"|"swing_low")
 * into analysisTypes.ts's SwingPoint[] (index/time/type:"high"|"low") that
 * chartPatterns.ts expects — looking up each swing's real timestamp from
 * the candle array by index.
 */
export function toAnalysisSwingPoints(candles: Candle[], smcSwings: SmcSwingPoint[]): SwingPoint[] {
  return smcSwings.map((s) => ({
    index: s.idx,
    time: candles[s.idx]?.timestamp ?? s.idx,
    price: s.price,
    type: s.type === "swing_high" ? "high" : "low",
  }));
}

export function splitSwings(swings: SwingPoint[]): { highs: SwingPoint[]; lows: SwingPoint[] } {
  return {
    highs: swings.filter((s) => s.type === "high"),
    lows: swings.filter((s) => s.type === "low"),
  };
}

/**
 * Summarizes smcAnalysis.ts's structure + liquidity output into the
 * confidence-scored MarketStructure shape for a single timeframe's
 * candle series. Call this with the SAME candles array you passed into
 * detectStructure()/detectLiquidity() so indices line up.
 */
export function summarizeMarketStructure(
  candles: Candle[],
  structure: StructureResult,
  liquidity: LiquidityZone[]
): MarketStructure {
  if (candles.length === 0) {
    return { bos: { ...EMPTY }, choch: { ...EMPTY }, equal_highs: { ...EMPTY }, equal_lows: { ...EMPTY }, liquidity_sweep: { ...EMPTY } };
  }

  const lastIdx = candles.length - 1;

  // Most recent BOS/CHoCH/sweep events within the recency window
  const latestBos = [...structure.bos].reverse().find((e) => lastIdx - e.idx <= RECENCY_WINDOW);
  const latestChoch = [...structure.choch].reverse().find((e) => lastIdx - e.idx <= RECENCY_WINDOW);
  const latestSweep = [...structure.sweeps].reverse().find((e) => lastIdx - e.idx <= RECENCY_WINDOW);
  const latestEqh = [...liquidity].reverse().find((z) => z.type === "buy_side_EQH" && lastIdx - z.idx <= RECENCY_WINDOW);
  const latestEql = [...liquidity].reverse().find((z) => z.type === "sell_side_EQL" && lastIdx - z.idx <= RECENCY_WINDOW);

  const bos: DetectionResult = latestBos
    ? {
        detected: true,
        confidence: recencyConfidence(latestBos.idx, lastIdx),
        direction: latestBos.type === "BOS_up" ? "bullish" : "bearish",
      }
    : { ...EMPTY };

  const choch: DetectionResult = latestChoch
    ? {
        detected: true,
        confidence: recencyConfidence(latestChoch.idx, lastIdx, 85, 55),
        direction: latestChoch.type === "CHOCH_up" ? "bullish" : "bearish",
      }
    : { ...EMPTY };

  // Sweep_High = liquidity grabbed above a prior high, typically a bearish
  // signal (reversal down expected); Sweep_Low is the bullish mirror.
  const liquidity_sweep: DetectionResult = latestSweep
    ? {
        detected: true,
        confidence: recencyConfidence(latestSweep.idx, lastIdx, 80, 50),
        direction: latestSweep.type === "Sweep_High" ? "bearish" : "bullish",
      }
    : { ...EMPTY };

  const equal_highs: DetectionResult = latestEqh
    ? { detected: true, confidence: recencyConfidence(latestEqh.idx, lastIdx, 75, 50) }
    : { ...EMPTY };

  const equal_lows: DetectionResult = latestEql
    ? { detected: true, confidence: recencyConfidence(latestEql.idx, lastIdx, 75, 50) }
    : { ...EMPTY };

  return { bos, choch, equal_highs, equal_lows, liquidity_sweep };
}
