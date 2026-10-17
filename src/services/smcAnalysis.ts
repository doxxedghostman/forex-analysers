// src/services/smcAnalysis.ts
//

export interface Candle {
  timestamp: number; // epoch ms (or seconds — just be consistent with marketData.ts)
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Bias = "Bullish" | "Bearish" | "Neutral";

export interface SwingPoint {
  idx: number; // integer position in the candles array
  type: "swing_high" | "swing_low";
  price: number;
}

export interface StructureEvent {
  idx: number;
  type: "BOS_up" | "BOS_down" | "CHOCH_up" | "CHOCH_down";
  price: number; // the level that was broken
}

export interface SweepEvent {
  idx: number;
  type: "Sweep_High" | "Sweep_Low";
  price: number; // the wick price that swept
}

export interface StructureResult {
  swings: SwingPoint[];
  bos: StructureEvent[];
  choch: StructureEvent[];
  sweeps: SweepEvent[];
}

export interface LiquidityZone {
  idx: number;
  type: "buy_side_EQH" | "sell_side_EQL" | "buy_side_SWING" | "sell_side_SWING";
  price: number;
}

// ---------------------------------------------------------------------------
// getPdBias — premium/discount bias from a daily-candle range
// ---------------------------------------------------------------------------
export function getPdBias(
  dailyCandles: Candle[],
  livePrice?: number,
  lookback = 60
): Bias {
  if (!dailyCandles || dailyCandles.length < 20) return "Neutral";

  const slice = dailyCandles.slice(-lookback);
  const low = Math.min(...slice.map((c) => c.low));
  const high = Math.max(...slice.map((c) => c.high));
  const eq = (high + low) / 2;

  const px = livePrice ?? dailyCandles[dailyCandles.length - 1].close;

  // Neutral band around equilibrium (10% of range)
  const band = (high - low) * 0.1;
  if (Math.abs(px - eq) <= band) return "Neutral";

  return px < eq ? "Bullish" : "Bearish";
}

// ---------------------------------------------------------------------------
// isKillzoneActive — London / New York session check (pure UTC hour math)
// ---------------------------------------------------------------------------
export function isKillzoneActive(now: Date = new Date()): {
  active: boolean;
  label: string;
} {
  const hourUtc = now.getUTCHours();

  // London Kill Zone: 7 AM - 10 AM UTC
  // New York Kill Zone: 12 PM - 3 PM UTC
  if ((hourUtc >= 7 && hourUtc <= 10) || (hourUtc >= 12 && hourUtc <= 15)) {
    return { active: true, label: "🔥 Kill Zone Active" };
  }
  return { active: false, label: "💤 Off-Hours (Low Volatility)" };
}

// ---------------------------------------------------------------------------
// detectStructure — swing highs/lows + BOS / CHoCH detection
// ---------------------------------------------------------------------------
export function detectStructure(
  candles: Candle[],
  swingLen = 2
): StructureResult {
  const empty: StructureResult = { swings: [], bos: [], choch: [], sweeps: [] };

  const n = candles.length;
  if (!candles || n < swingLen * 2 + 5) return empty;

  const swings: SwingPoint[] = [];

  // --- 1) Swing points (fractals) ---
  for (let i = swingLen; i < n - swingLen; i++) {
    const windowHighs = candles
      .slice(i - swingLen, i + swingLen + 1)
      .map((c) => c.high);
    const windowLows = candles
      .slice(i - swingLen, i + swingLen + 1)
      .map((c) => c.low);

    const hi = candles[i].high;
    const lo = candles[i].low;

    const maxHigh = Math.max(...windowHighs);
    const minLow = Math.min(...windowLows);

    if (hi === maxHigh && windowHighs.filter((h) => h === hi).length === 1) {
      swings.push({ idx: i, type: "swing_high", price: hi });
    } else if (lo === minLow && windowLows.filter((l) => l === lo).length === 1) {
      swings.push({ idx: i, type: "swing_low", price: lo });
    }
  }

  if (swings.length < 2) return { ...empty, swings };

  // --- 2) BOS / CHoCH / Sweeps ---
  // Rough trend guess using the last 3 swings up to index j
  function lastTrend(swingList: SwingPoint[], uptoJ: number): "up" | "down" | "unknown" {
    if (uptoJ < 3) return "unknown";
    const a = swingList[uptoJ - 3];
    const b = swingList[uptoJ - 2];
    const c = swingList[uptoJ - 1];
    if (a.type === "swing_high" && b.type === "swing_low" && c.type === "swing_high") {
      return "up";
    }
    if (a.type === "swing_low" && b.type === "swing_high" && c.type === "swing_low") {
      return "down";
    }
    return "unknown";
  }

  const bos: StructureEvent[] = [];
  const choch: StructureEvent[] = [];
  const sweeps: SweepEvent[] = [];

  for (let j = 1; j < swings.length; j++) {
    const prev = swings[j - 1];
    const curr = swings[j];

    const idx = curr.idx;
    const currClose = candles[idx].close;
    const currHigh = candles[idx].high;
    const currLow = candles[idx].low;
    const prevPrice = prev.price;

    if (prev.type === "swing_high") {
      if (currClose > prevPrice) {
        bos.push({ idx, type: "BOS_up", price: prevPrice });
      } else if (currHigh > prevPrice && currClose <= prevPrice) {
        sweeps.push({ idx, type: "Sweep_High", price: currHigh });
      } else if (lastTrend(swings, j) === "up" && currClose < prevPrice) {
        choch.push({ idx, type: "CHOCH_down", price: prevPrice });
      }
    } else if (prev.type === "swing_low") {
      if (currClose < prevPrice) {
        bos.push({ idx, type: "BOS_down", price: prevPrice });
      } else if (currLow < prevPrice && currClose >= prevPrice) {
        sweeps.push({ idx, type: "Sweep_Low", price: currLow });
      } else if (lastTrend(swings, j) === "down" && currClose > prevPrice) {
        choch.push({ idx, type: "CHOCH_up", price: prevPrice });
      }
    }
  }

  return { swings, bos, choch, sweeps };
}

// ---------------------------------------------------------------------------
// detectLiquidity — equal highs/lows + swing-based external liquidity zones
// ---------------------------------------------------------------------------
export function detectLiquidity(candles: Candle[]): LiquidityZone[] {
  const zones: LiquidityZone[] = [];
  if (!candles || candles.length === 0) return zones;

  const currentPrice = candles[candles.length - 1].close;
  const threshold = currentPrice * 0.0005; // 0.05% of current price

  // 1) Equal highs (buy-side liquidity) / equal lows (sell-side liquidity)
  for (let i = 1; i < candles.length; i++) {
    if (Math.abs(candles[i].high - candles[i - 1].high) < threshold) {
      zones.push({ idx: i, type: "buy_side_EQH", price: candles[i].high });
    } else if (Math.abs(candles[i].low - candles[i - 1].low) < threshold) {
      zones.push({ idx: i, type: "sell_side_EQL", price: candles[i].low });
    }
  }

  // 2) Swing highs/lows (external range liquidity)
  for (let i = 5; i < candles.length - 5; i++) {
    const windowHighs = candles.slice(i - 5, i + 5).map((c) => c.high);
    const windowLows = candles.slice(i - 5, i + 5).map((c) => c.low);

    if (candles[i].high === Math.max(...windowHighs)) {
      zones.push({ idx: i, type: "buy_side_SWING", price: candles[i].high });
    }
    if (candles[i].low === Math.min(...windowLows)) {
      zones.push({ idx: i, type: "sell_side_SWING", price: candles[i].low });
    }
  }

  return zones;
}

