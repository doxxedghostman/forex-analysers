// chartPatterns.ts
// Geometric chart pattern detection from swing high/low data.
// Consumes the same SwingPoint[] that marketAnalyzer.ts already extracts
// for BOS/CHoCH — don't recompute swings twice.

import { CONFIDENCE_THRESHOLD, DetectionResult, PatternSet, SwingPoint } from "./analysisTypes";

const EMPTY: DetectionResult = { detected: false, confidence: 0 };

function emptyPatternSet(): PatternSet {
  return {
    double_top: { ...EMPTY },
    double_bottom: { ...EMPTY },
    head_and_shoulders: { ...EMPTY },
    inverse_head_and_shoulders: { ...EMPTY },
    ascending_triangle: { ...EMPTY },
    descending_triangle: { ...EMPTY },
    symmetrical_triangle: { ...EMPTY },
    bull_flag: { ...EMPTY },
    bear_flag: { ...EMPTY },
    rising_wedge: { ...EMPTY },
    falling_wedge: { ...EMPTY },
    engulfing: { ...EMPTY },
  };
}

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Double Top: two swing highs at roughly the same price level, separated
 * by a swing low in between (the "neckline"), with the second high
 * ideally showing weaker momentum (a lower high than the first, or equal).
 */
function detectDoubleTop(highs: SwingPoint[], lows: SwingPoint[]): DetectionResult {
  if (highs.length < 2) return { ...EMPTY };

  // Look at the two most recent swing highs
  const [h2, h1] = highs.slice(-2); // h1 = most recent, h2 = prior
  if (!h1 || !h2) return { ...EMPTY };

  const priceDiffPct = Math.abs(h1.price - h2.price) / h2.price * 100;

  // Must be a low between the two highs (the neckline)
  const neckline = lows.find((l) => l.index > h2.index && l.index < h1.index);
  if (!neckline) return { ...EMPTY };

  // Tighter price match between the two tops = higher confidence
  // 0% diff -> ~95 confidence, 1%+ diff -> confidence drops off fast
  let confidence = clamp(95 - priceDiffPct * 40);

  // Bonus if second high failed to exceed first high meaningfully (classic double top)
  if (h1.price <= h2.price * 1.001) confidence = clamp(confidence + 5);

  return {
    detected: confidence >= CONFIDENCE_THRESHOLD,
    confidence: Math.round(confidence),
    direction: "bearish",
  };
}

/**
 * Double Bottom: mirror of double top — two swing lows at similar levels
 * separated by a swing high (neckline).
 */
function detectDoubleBottom(highs: SwingPoint[], lows: SwingPoint[]): DetectionResult {
  if (lows.length < 2) return { ...EMPTY };

  const [l2, l1] = lows.slice(-2);
  if (!l1 || !l2) return { ...EMPTY };

  const priceDiffPct = Math.abs(l1.price - l2.price) / l2.price * 100;

  const neckline = highs.find((h) => h.index > l2.index && h.index < l1.index);
  if (!neckline) return { ...EMPTY };

  let confidence = clamp(95 - priceDiffPct * 40);
  if (l1.price >= l2.price * 0.999) confidence = clamp(confidence + 5);

  return {
    detected: confidence >= CONFIDENCE_THRESHOLD,
    confidence: Math.round(confidence),
    direction: "bullish",
  };
}

/**
 * Head & Shoulders: three swing highs — left shoulder, head (highest),
 * right shoulder — where left and right shoulders are roughly symmetric
 * in both price and time spacing, and the head clearly exceeds both.
 */
function detectHeadAndShoulders(highs: SwingPoint[], lows: SwingPoint[]): DetectionResult {
  if (highs.length < 3) return { ...EMPTY };

  const [leftShoulder, head, rightShoulder] = highs.slice(-3);
  if (!leftShoulder || !head || !rightShoulder) return { ...EMPTY };

  // Head must be the highest of the three
  if (head.price <= leftShoulder.price || head.price <= rightShoulder.price) {
    return { ...EMPTY };
  }

  // Shoulders should be roughly symmetric in price (within ~2%)
  const shoulderPriceDiffPct =
    Math.abs(leftShoulder.price - rightShoulder.price) / leftShoulder.price * 100;

  // Shoulders should be roughly symmetric in time spacing from the head
  const leftSpan = head.index - leftShoulder.index;
  const rightSpan = rightShoulder.index - head.index;
  const spanRatio = Math.min(leftSpan, rightSpan) / Math.max(leftSpan, rightSpan);

  // There should be two intervening lows forming the neckline
  const necklineLows = lows.filter(
    (l) => l.index > leftShoulder.index && l.index < rightShoulder.index
  );
  if (necklineLows.length < 2) return { ...EMPTY };

  let confidence = 90 - shoulderPriceDiffPct * 15;
  confidence *= spanRatio; // penalize asymmetric timing
  confidence = clamp(confidence);

  return {
    detected: confidence >= CONFIDENCE_THRESHOLD,
    confidence: Math.round(confidence),
    direction: "bearish",
  };
}

/** Inverse Head & Shoulders: mirror of H&S using swing lows. */
function detectInverseHeadAndShoulders(highs: SwingPoint[], lows: SwingPoint[]): DetectionResult {
  if (lows.length < 3) return { ...EMPTY };

  const [leftShoulder, head, rightShoulder] = lows.slice(-3);
  if (!leftShoulder || !head || !rightShoulder) return { ...EMPTY };

  if (head.price >= leftShoulder.price || head.price >= rightShoulder.price) {
    return { ...EMPTY };
  }

  const shoulderPriceDiffPct =
    Math.abs(leftShoulder.price - rightShoulder.price) / leftShoulder.price * 100;

  const leftSpan = head.index - leftShoulder.index;
  const rightSpan = rightShoulder.index - head.index;
  const spanRatio = Math.min(leftSpan, rightSpan) / Math.max(leftSpan, rightSpan);

  const necklineHighs = highs.filter(
    (h) => h.index > leftShoulder.index && h.index < rightShoulder.index
  );
  if (necklineHighs.length < 2) return { ...EMPTY };

  let confidence = 90 - shoulderPriceDiffPct * 15;
  confidence *= spanRatio;
  confidence = clamp(confidence);

  return {
    detected: confidence >= CONFIDENCE_THRESHOLD,
    confidence: Math.round(confidence),
    direction: "bullish",
  };
}

/**
 * Main entry point. Pass in the swing highs/lows already derived for this
 * timeframe (same ones marketAnalyzer.ts uses for BOS/CHoCH/equal highs).
 * Triangles, flags, wedges are stubbed as { detected: false } for now —
 * Phase 3 follow-up once double top/bottom and H&S are validated live.
 */
export function detectChartPatterns(
  highs: SwingPoint[],
  lows: SwingPoint[]
): PatternSet {
  const patterns = emptyPatternSet();

  patterns.double_top = detectDoubleTop(highs, lows);
  patterns.double_bottom = detectDoubleBottom(highs, lows);
  patterns.head_and_shoulders = detectHeadAndShoulders(highs, lows);
  patterns.inverse_head_and_shoulders = detectInverseHeadAndShoulders(highs, lows);

  // engulfing, triangles, flags, wedges: TODO — next pass
  return patterns;
}
