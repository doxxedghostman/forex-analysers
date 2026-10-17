// analysisTypes.ts
// Shared types for market structure + chart pattern detection.
// Imported by: chartPatterns.ts, marketAnalyzer.ts, api/scan route, scanPrompt.ts, frontend components.

export type Direction = "bullish" | "bearish" | null;

/**
 * Generic shape for anything that gets "detected" with a confidence score.
 * Always present in the payload, even when detected = false, so the AI
 * (and the UI) can see what was checked, not just what was found.
 */
export interface DetectionResult {
  detected: boolean;
  confidence: number; // 0-100
  direction?: Direction; // only for patterns/structure that have inherent directional bias
}

/** Basic indicator readouts (Phase 1) */
export interface IndicatorSnapshot {
  rsi: number;
  macd: Direction | "neutral";
  ema: string; // e.g. "Price above EMA200"
  adx: number;
  atr?: number;
  supertrend?: Direction;
}

/** Market structure / SMC concepts (Phase 2) */
export interface MarketStructure {
  bos: DetectionResult;
  choch: DetectionResult;
  equal_highs: DetectionResult;
  equal_lows: DetectionResult;
  liquidity_sweep: DetectionResult;
  fair_value_gap?: DetectionResult;
  order_block?: DetectionResult;
}

/** Chart + candlestick patterns (Phase 3) */
export interface PatternSet {
  double_top: DetectionResult;
  double_bottom: DetectionResult;
  head_and_shoulders: DetectionResult;
  inverse_head_and_shoulders: DetectionResult;
  ascending_triangle: DetectionResult;
  descending_triangle: DetectionResult;
  symmetrical_triangle: DetectionResult;
  bull_flag: DetectionResult;
  bear_flag: DetectionResult;
  rising_wedge: DetectionResult;
  falling_wedge: DetectionResult;
  engulfing: DetectionResult; // direction indicates bullish/bearish engulfing
}

export interface TimeframeAnalysis {
  trend: "Bullish" | "Bearish" | "Neutral";
  timestamp: string; // ISO string, when this scan was computed
  price_at_detection: number;
  indicators: IndicatorSnapshot;
  market_structure: MarketStructure;
  patterns: PatternSet;
}

export type TimeframeKey = "15m" | "1H" | "4H" | "1D";

export interface PairAnalysis {
  pair: string;
  timeframes: Partial<Record<TimeframeKey, TimeframeAnalysis>>;
}

/** A single swing point extracted from OHLCV data — the shared input
 * that both marketAnalyzer.ts (structure) and chartPatterns.ts (geometry)
 * should derive from, rather than each recomputing swings independently. */
export interface SwingPoint {
  index: number; // candle index in the OHLCV array
  time: number; // unix timestamp
  price: number;
  type: "high" | "low";
}

/** Confidence >= this counts as "detected: true". Single source of truth,
 * imported by both marketAnalyzer.ts and chartPatterns.ts so every
 * detector function applies the same cutoff. */
export const CONFIDENCE_THRESHOLD = 50;
