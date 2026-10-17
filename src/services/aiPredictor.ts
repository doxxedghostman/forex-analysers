// src/services/aiPredictor.ts

import { computeIndicators } from "./marketAnalyzer";
import {
  Candle,
  getPdBias,
  isKillzoneActive,
  detectStructure,
  detectLiquidity,
} from "./smcAnalysis";

// ============================================================================
// Types
// ============================================================================

export type TradeSide = "buy_limit" | "sell_limit";
export type Direction = "Long" | "Short" | "Neutral";
// Separate from Direction ("Long"/"Short"/"Neutral") because the SMC scoring
// logic below produces "Bullish"/"Bearish"/"Neutral" — different vocabulary,
// never mixed with Long/Short anywhere they're actually compared.
export type SmcBias = "Bullish" | "Bearish" | "Neutral";
export type Preferred = "Long" | "Short" | "None";

export interface TradePlan {
  type: TradeSide | null;
  entry: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  rr: number | null;
  trigger: string | null;
  symbol?: string;
}

export interface SmcContext {
  pd_bias: SmcBias;
  killzone_active: boolean;
  killzone_label: string;
  has_bullish_sweep: boolean;
  has_bearish_sweep: boolean;
  bos_count: number;
  choch_count: number;
  smc_bias: SmcBias;
  notes: string[];
}

export interface PredictionResult {
  direction: Direction;
  confidence_score: number;
  trade_strength: string;
  live_price: number | null;
  market_state: "Bullish" | "Bearish" | "Neutral";
  preferred: Preferred;
  long_setup: TradePlan | Record<string, never>;
  short_setup: TradePlan | Record<string, never>;
  reasoning: string;
  notes: string;
  ai_raw: unknown;
}

// ============================================================================
// Small math / formatting helpers (direct ports, pure functions)
// ============================================================================

export function sf(x: unknown, fallback = 0): number {
  if (x === null || x === undefined) return fallback;
  const n = typeof x === "number" ? x : parseFloat(String(x).replace(/,/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

function toFloatOrNull(x: unknown): number | null {
  if (x === null || x === undefined) return null;
  const n = typeof x === "number" ? x : parseFloat(String(x).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function isXau(symbol: string): boolean {
  const s = (symbol || "").toUpperCase().replace("/", "");
  return s.includes("XAU") || s.includes("GOLD");
}

function isXauOrXag(symbol: string): boolean {
  const s = (symbol || "").toUpperCase().replace("/", "");
  return s.includes("XAU") || s.includes("GOLD") || s.includes("XAG");
}

export function isJpy(symbol: string): boolean {
  return (symbol || "").toUpperCase().includes("JPY");
}

export function pricePrecision(symbol: string): number {
  const s = (symbol || "").toUpperCase().replace("/", "");
  if (s.includes("XAU") || s.includes("GOLD")) return 2;
  if (s.includes("JPY") && s.length >= 6) return 3;
  return 5;
}

export function roundPx(value: number | null | undefined, symbol: string): number | null {
  if (value === null || value === undefined) return null;
  try {
    const precision = pricePrecision(symbol);
    return Number(value.toFixed(precision));
  } catch {
    return Number(value.toFixed(2));
  }
}

export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

export function nearestBelow(levels: number[], px: number): number | null {
  const vals = (levels || []).filter((x) => x !== null && x !== undefined && x < px);
  return vals.length ? Math.max(...vals) : null;
}

export function nearestAbove(levels: number[], px: number): number | null {
  const vals = (levels || []).filter((x) => x !== null && x !== undefined && x > px);
  return vals.length ? Math.min(...vals) : null;
}

function nearestLevels(levels: number[], px: number, side: "below" | "above", k = 3): number[] {
  const sorted = [...(levels || [])].sort((a, b) => a - b);
  if (side === "below") {
    return sorted.filter((x) => x < px).slice(-k);
  }
  return sorted.filter((x) => x > px).slice(0, k);
}

export function normalizeLevels(levels: unknown): number[] {
  const out: number[] = [];
  for (const x of (levels as unknown[]) || []) {
    if (x === null || x === undefined) continue;
    if (typeof x === "number") {
      out.push(x);
    } else if (typeof x === "string") {
      const n = parseFloat(x.trim());
      if (Number.isFinite(n)) out.push(n);
    } else if (typeof x === "object") {
      const obj = x as Record<string, unknown>;
      for (const k of ["level", "price", "value"]) {
        if (obj[k] !== undefined && obj[k] !== null) {
          out.push(Number(obj[k]));
          break;
        }
      }
    } else if (Array.isArray(x) && x.length >= 2) {
      out.push(Number(x[1]));
    }
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

// ============================================================================
// OHLC validation
// ============================================================================

export function validateOhlc(candles: Candle[], minLength = 20): boolean {
  if (!candles || candles.length < minLength) return false;

  for (const candle of candles) {
    for (const key of ["open", "high", "low", "close"] as const) {
      const val = (candle as unknown as Record<string, unknown>)[key];
      if (val === undefined || val === null) return false;
      const num = Number(val);
      if (!Number.isFinite(num) || num <= 0) return false;
    }
    // Volume is frequently null/undefined for spot forex on Yahoo (unlike futures
    // like GC=F/SI=F) — don't hard-fail on absence, only on a present-but-invalid value.
    const vol = (candle as unknown as Record<string, unknown>)["volume"];
    if (vol !== undefined && vol !== null) {
      const volNum = Number(vol);
      if (!Number.isFinite(volNum) || volNum < 0) return false;
    }
  }
  return true;
}

// ============================================================================
// Volatility classification
// ============================================================================
// Ported intent of classify_volatility, but reads ATR / Bollinger width off
// the already-computed indicators object instead of recomputing them —
// computeIndicators() in marketAnalyzer.ts already produces both.
// Verify the exact key names against your actual computeIndicators() output.

export interface VolatilityClass {
  level: "High" | "Medium" | "Low" | "Unknown";
  label: string;
  slMult: number;
  tpMult: number;
}

export function classifyVolatility(
  indicators: Record<string, any>,
  lastClose: number
): VolatilityClass {
  const atr = sf(indicators?.atr_14 ?? indicators?.atr, 0);
  const bollWidth = sf(
    indicators?.bollinger?.width?.at?.(-1) ?? indicators?.bb_width ?? indicators?.bollinger_width,
    0
  );

  if (!lastClose) return { level: "Unknown", label: "Unknown ❓", slMult: 2.0, tpMult: 3.0 };

  if (atr > 0.015 * lastClose || bollWidth / lastClose > 0.02) {
    return { level: "High", label: "Overheated 🔴", slMult: 3.0, tpMult: 6.0 };
  }
  if (atr > 0.0075 * lastClose || bollWidth / lastClose > 0.01) {
    return { level: "Medium", label: "Good 🟢", slMult: 2.0, tpMult: 6.0 };
  }
  return { level: "Low", label: "Weak 🟡", slMult: 1.5, tpMult: 4.5 };
}

// ============================================================================
// validateTrade — the safety layer. Never trust the AI's numbers blindly.
// ============================================================================

export function validateTrade(plan: Partial<TradePlan> | null | undefined, minRrIn = 1.8): boolean {
  if (!plan) return false;

  const normType = (x: unknown): TradeSide | "" => {
    const s = String(x || "").trim().toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
    if (["buy", "long", "buy_limit", "long_limit"].includes(s)) return "buy_limit";
    if (["sell", "short", "sell_limit", "short_limit"].includes(s)) return "sell_limit";
    return "";
  };

  const tradeType = normType(plan.type);
  if (tradeType !== "buy_limit" && tradeType !== "sell_limit") return false;

  const entry = toFloatOrNull(plan.entry);
  const slPrice = toFloatOrNull(plan.stop_loss);
  const tpPrice = toFloatOrNull(plan.take_profit);
  let rr = toFloatOrNull(plan.rr);

  if (entry === null || slPrice === null || tpPrice === null) return false;
  if (entry <= 0 || slPrice <= 0 || tpPrice <= 0) return false;

  let minRr = minRrIn;
  const trigger = String(plan.trigger || "").toLowerCase();
  if (
    ["base", "technical", "support", "resistance", "pullback", "limit", "structure", "rejection", "zone"].some(
      (k) => trigger.includes(k)
    )
  ) {
    minRr = Math.min(minRr, 1.2);
  }

  let risk: number;
  let reward: number;

  if (tradeType === "buy_limit") {
    if (!(slPrice < entry && entry < tpPrice)) return false;
    risk = entry - slPrice;
    reward = tpPrice - entry;
  } else {
    if (!(tpPrice < entry && entry < slPrice)) return false;
    risk = slPrice - entry;
    reward = entry - tpPrice;
  }

  if (risk <= 0 || reward <= 0) return false;

  const calcRr = reward / risk;
  if (rr !== null && rr > 0) {
    if (Math.abs(rr - calcRr) > 0.35) rr = calcRr;
  } else {
    rr = calcRr;
  }

  if (calcRr < minRr) return false;
  if (reward > risk * 6.0) return false;
  if (risk > reward * 3.5) return false;

  return true;
}

// ============================================================================
// _build_dual_limit_setups — deterministic geometry from S/R + ATR
// ============================================================================

export function buildDualLimitSetups(
  livePrice: number,
  atrIn: number,
  supportsIn: number[],
  resistancesIn: number[],
  minRrIn: number,
  symbol: string,
  entryKIn = 0.55,
  slKIn = 0.7,
  tpFrontKIn = 0.2
): { long: TradePlan | Record<string, never>; short: TradePlan | Record<string, never> } {
  const empty = {};
  if (!Number.isFinite(livePrice) || livePrice <= 0) return { long: empty, short: empty };
  const atr = Number.isFinite(atrIn) ? atrIn : 0;
  if (atr <= 0) return { long: empty, short: empty };

  const cleanLevels = (levels: number[]) =>
    Array.from(new Set((levels || []).filter((x) => Number.isFinite(x) && x > 0))).sort((a, b) => a - b);

  const supports = cleanLevels(supportsIn);
  const resistances = cleanLevels(resistancesIn);

  const levelsAbove = (levels: number[], px: number) => levels.filter((x) => x > px);
  const levelsBelow = (levels: number[], px: number) => levels.filter((x) => x < px);

  const frontRun = (level: number, direction: "below" | "above", atrValue: number, frontK: number) =>
    direction === "below" ? level - frontK * atrValue : level + frontK * atrValue;

  const okLong = (entry: number | null, slp: number | null, tp: number | null, rr: number) =>
    entry !== null && slp !== null && tp !== null && slp < entry && entry < tp && rr >= minRrIn;

  const okShort = (entry: number | null, slp: number | null, tp: number | null, rr: number) =>
    entry !== null && slp !== null && tp !== null && tp < entry && entry < slp && rr >= minRrIn;

  const xau = isXauOrXag(symbol);
  let entryK = entryKIn;
  let slK = slKIn;
  const tpFrontK = tpFrontKIn;
  let targetRrFloor: number;
  let fallbackBandK: number;

  if (xau) {
    entryK = 0.4;
    slK = Math.max(slK, 0.7);
    targetRrFloor = Math.max(minRrIn, 1.5);
    fallbackBandK = 0.75;
  } else {
    targetRrFloor = Math.max(minRrIn, 1.5);
    fallbackBandK = 0.8;
  }

  let longSetup: TradePlan | Record<string, never> = {};
  let shortSetup: TradePlan | Record<string, never> = {};

  const nSup = nearestBelow(supports, livePrice);
  const nRes = nearestAbove(resistances, livePrice);

  // ---- Long setup ----
  if (nSup !== null) {
    const entry = nSup + entryK * atr;
    const slp = nSup - slK * atr;
    const risk = Math.abs(entry - slp);

    const resAboveEntry = levelsAbove(resistances, entry);
    const nearestResAfterEntry = resAboveEntry.length ? Math.min(...resAboveEntry) : null;

    const wallTp = nearestResAfterEntry !== null ? frontRun(nearestResAfterEntry, "below", atr, tpFrontK) : null;
    const rrTp = Math.max(entry + targetRrFloor * risk, livePrice + 0.2 * atr);
    const tp = wallTp !== null && wallTp > entry ? Math.max(wallTp, rrTp) : rrTp;

    const rr = Math.abs(tp - entry) / Math.max(1e-9, risk);

    if (okLong(entry, slp, tp, rr)) {
      longSetup = {
        type: "buy_limit",
        entry: roundPx(entry, symbol),
        stop_loss: roundPx(slp, symbol),
        take_profit: roundPx(tp, symbol),
        rr: Math.round(rr * 100) / 100,
        trigger: `Pullback into support zone (~${roundPx(nSup, symbol)}). Limit LONG setup.`,
      };
    }
  }

  // ---- Short setup ----
  if (nRes !== null) {
    const entry = nRes - entryK * atr;
    const slp = nRes + slK * atr;
    const risk = Math.abs(slp - entry);

    const supBelowEntry = levelsBelow(supports, entry);
    const nearestSupAfterEntry = supBelowEntry.length ? Math.max(...supBelowEntry) : null;

    const wallTp = nearestSupAfterEntry !== null ? frontRun(nearestSupAfterEntry, "above", atr, tpFrontK) : null;
    const rrTp = Math.min(entry - targetRrFloor * risk, livePrice - 0.2 * atr);
    const tp = wallTp !== null && wallTp < entry ? Math.min(wallTp, rrTp) : rrTp;

    const rr = Math.abs(entry - tp) / Math.max(1e-9, risk);

    if (okShort(entry, slp, tp, rr)) {
      shortSetup = {
        type: "sell_limit",
        entry: roundPx(entry, symbol),
        stop_loss: roundPx(slp, symbol),
        take_profit: roundPx(tp, symbol),
        rr: Math.round(rr * 100) / 100,
        trigger: `Rejection from resistance zone (~${roundPx(nRes, symbol)}). Limit SHORT setup.`,
      };
    }
  }

  // ---- Controlled fallback when no wall exists on that side ----
  if (!("entry" in longSetup) && nSup === null) {
    const entry = livePrice - fallbackBandK * atr;
    const slp = entry - slK * atr;
    const risk = Math.abs(entry - slp);
    const tp = Math.max(entry + targetRrFloor * risk, livePrice + 0.2 * atr);
    const rr = Math.abs(tp - entry) / Math.max(1e-9, risk);

    if (okLong(entry, slp, tp, rr)) {
      longSetup = {
        type: "buy_limit",
        entry: roundPx(entry, symbol),
        stop_loss: roundPx(slp, symbol),
        take_profit: roundPx(tp, symbol),
        rr: Math.round(rr * 100) / 100,
        trigger: "Fallback LONG limit from ATR pullback band.",
      };
    }
  }

  if (!("entry" in shortSetup) && nRes === null) {
    const entry = livePrice + fallbackBandK * atr;
    const slp = entry + slK * atr;
    const risk = Math.abs(slp - entry);
    const tp = Math.min(entry - targetRrFloor * risk, livePrice - 0.2 * atr);
    const rr = Math.abs(entry - tp) / Math.max(1e-9, risk);

    if (okShort(entry, slp, tp, rr)) {
      shortSetup = {
        type: "sell_limit",
        entry: roundPx(entry, symbol),
        stop_loss: roundPx(slp, symbol),
        take_profit: roundPx(tp, symbol),
        rr: Math.round(rr * 100) / 100,
        trigger: "Fallback SHORT limit from ATR pullback band.",
      };
    }
  }

  return { long: longSetup, short: shortSetup };
}

// ============================================================================
// normalizeTradePlan — merges/cleans any raw plan (AI output or otherwise)
// into a stable shape, inferring type from geometry/live price when missing.
// ============================================================================

export function normalizeTradePlan(
  plan: Record<string, any> | null | undefined,
  symbol = "",
  livePrice: number | null = null
): TradePlan | Record<string, never> {
  if (!plan || typeof plan !== "object") return {};

  const pick = (...keys: string[]) => {
    for (const k of keys) {
      if (plan[k] !== undefined && plan[k] !== null) return plan[k];
    }
    return null;
  };

  const entryRaw = pick("entry", "entry_price", "activated_entry_price", "price", "limit_price");
  const slRaw = pick("stop_loss", "stop_loss_price", "sl", "SL", "stop");
  const tpRaw = pick("take_profit", "take_profit_price", "target_price", "tp", "TP", "take");
  const typRaw = pick("type", "entry_type", "order_type", "side", "position");
  const rrRaw = pick("rr", "risk_reward", "riskReward", "r_r");
  const trigRaw = pick("trigger", "trig", "condition", "reason");

  let entry = toFloatOrNull(entryRaw);
  let stopLoss = toFloatOrNull(slRaw);
  let takeProfit = toFloatOrNull(tpRaw);
  let rr = toFloatOrNull(rrRaw);

  let typ: TradeSide | null = null;
  if (typRaw) {
    const t = String(typRaw).trim().toLowerCase();
    if (t.includes("buy") || t.includes("long")) typ = "buy_limit";
    else if (t.includes("sell") || t.includes("short")) typ = "sell_limit";
  }

  // Zero out bogus near-zero values
  if (entry !== null && Math.abs(entry) < 1e-12) entry = null;
  if (stopLoss !== null && Math.abs(stopLoss) < 1e-12) stopLoss = null;
  if (takeProfit !== null && Math.abs(takeProfit) < 1e-12) takeProfit = null;

  const e = entry;
  const s = stopLoss;
  const t = takeProfit;

  // Infer type from geometry
  if (typ === null && e !== null && s !== null && t !== null) {
    if (s < e && e < t) typ = "buy_limit";
    else if (t < e && e < s) typ = "sell_limit";
  }

  // Infer type from live price
  if (typ === null && livePrice && e !== null) {
    if (e < livePrice) typ = "buy_limit";
    else if (e > livePrice) typ = "sell_limit";
  }

  // Geometry enforcement — flip type if geometry only matches the other
  // side, otherwise drop the invalid SL/TP
  if (e !== null && s !== null && t !== null) {
    if (typ === "buy_limit" && !(s < e && e < t)) {
      typ = t < e && e < s ? "sell_limit" : null;
    } else if (typ === "sell_limit" && !(t < e && e < s)) {
      typ = s < e && e < t ? "buy_limit" : null;
    }
  }

  // Distance sanity — entry more than 10% from live price is nonsense
  if (livePrice && e !== null) {
    const dist = Math.abs(e - livePrice);
    if (dist > livePrice * 0.1) return {};
  }

  // RR calculation
  if (e !== null && s !== null && t !== null) {
    const risk = Math.abs(e - s);
    if (risk > 0) {
      const calcRr = Math.abs(t - e) / risk;
      if (rr === null || rr <= 0) rr = calcRr;
      rr = Math.round(rr * 100) / 100;
    }
  }

  return {
    symbol: symbol || plan.symbol || "",
    type: typ,
    entry: e,
    stop_loss: s,
    take_profit: t,
    rr,
    trigger: trigRaw ? String(trigRaw).trim() : null,
  };
}

// ============================================================================
// getSmcContext — confirmation/veto signals only, does not build trades
// ============================================================================

function normalizeTf(tf: string): string {
  const s = String(tf || "").trim().toLowerCase();
  if (["15m", "15min", "m15", "15"].includes(s)) return "15m";
  if (["1h", "60m", "h1", "60"].includes(s)) return "1h";
  if (["4h", "240m", "h4", "240"].includes(s)) return "4h";
  if (["1d", "d", "daily"].includes(s)) return "1d";
  return s;
}

export async function getSmcContext(
  symbol: string,
  _interval: string,
  candles: Candle[],
  allData?: Record<string, Candle[]>
): Promise<SmcContext> {
  const out: SmcContext = {
    pd_bias: "Neutral",
    killzone_active: false,
    killzone_label: "",
    has_bullish_sweep: false,
    has_bearish_sweep: false,
    bos_count: 0,
    choch_count: 0,
    smc_bias: "Neutral",
    notes: [],
  };

  try {
    if (!candles || candles.length < 20) return out;

    // 1) Daily premium/discount bias
    let df1d = candles;
    if (allData) {
      const normalizedMap: Record<string, Candle[]> = {};
      for (const [k, v] of Object.entries(allData)) normalizedMap[normalizeTf(k)] = v;
      if (normalizedMap["1d"]) df1d = normalizedMap["1d"];
    }
    const livePrice = candles[candles.length - 1]?.close;
    out.pd_bias = getPdBias(df1d, livePrice) as SmcBias;

    // 2) Killzone
    const kz = isKillzoneActive();
    out.killzone_active = kz.active;
    out.killzone_label = kz.label;

    // 3) Structure
    const { bos, choch } = detectStructure(candles);
    out.bos_count = bos.length;
    out.choch_count = choch.length;

    // 4) Liquidity + recent sweep detection
    const liqZones = detectLiquidity(candles);
    const recentCandles = isXau(symbol) ? 6 : 8;
    const start = Math.max(0, candles.length - recentCandles);

    let bullishSweepHits = 0;
    let bearishSweepHits = 0;

    for (let i = start; i < candles.length; i++) {
      const candle = candles[i];
      for (const zone of liqZones) {
        if (zone.idx >= i) continue;
        if (i - zone.idx > 30) continue;

        const zType = zone.type.toLowerCase();
        if (zType.includes("sell_side") && candle.low < zone.price && candle.close > zone.price) {
          bullishSweepHits += i >= candles.length - 3 ? 2 : 1;
        }
        if (zType.includes("buy_side") && candle.high > zone.price && candle.close < zone.price) {
          bearishSweepHits += i >= candles.length - 3 ? 2 : 1;
        }
      }
    }

    out.has_bullish_sweep = bullishSweepHits > 0;
    out.has_bearish_sweep = bearishSweepHits > 0;

    // 5) Directional scoring
    let bullScore = 0;
    let bearScore = 0;

    if (out.pd_bias === "Bullish") bullScore += 2;
    else if (out.pd_bias === "Bearish") bearScore += 2;

    bullScore += bullishSweepHits;
    bearScore += bearishSweepHits;

    if (out.bos_count > out.choch_count) bullScore += 2;
    else if (out.choch_count > out.bos_count) bearScore += 2;

    const recentBos = bos.slice(-3).length;
    const recentChoch = choch.slice(-3).length;
    if (recentBos > recentChoch) bullScore += 1;
    else if (recentChoch > recentBos) bearScore += 1;

    if (out.killzone_active) {
      if (bullishSweepHits > bearishSweepHits || recentBos > recentChoch) bullScore += 1;
      else if (bearishSweepHits > bullishSweepHits || recentChoch > recentBos) bearScore += 1;
    }

    const threshold = isXau(symbol) ? 2 : 1;
    if (bullScore - bearScore >= threshold) out.smc_bias = "Bullish";
    else if (bearScore - bullScore >= threshold) out.smc_bias = "Bearish";
    else out.smc_bias = "Neutral";

    return out;
  } catch (e) {
    out.notes.push(`smc_error: ${e}`);
    return out;
  }
}

// ============================================================================
// prepareMarketContext — the main technical/structural context builder
// ============================================================================
// NOTE: news integration is stubbed out here (see file header). Multi-tf
// All timeframe data must come from the saved input bundle.

export interface MarketContext {
  symbol: string;
  price_latest: number;
  ref_price: number;
  indicators: Record<string, any>;
  interval: string;
  resistance_levels: number[];
  support_levels: number[];
  support_levels_all: number[];
  resistance_levels_all: number[];
  structure_location: { label: string; position_0_1: number; no_trade_zone: boolean };
  htf_alignment: { score: number; bias: Direction };
  entry_plan: {
    bias: Direction;
    entry_type: TradeSide | null;
    entry_price: number | null;
    stop_loss: number | null;
    take_profit: number | null;
    rr: number;
  };
  confidence_score: number;
  news_summary: string;
  multi_tf: Record<string, Record<string, any>>;
  risk_flags: { equal_highs: boolean; equal_lows: boolean; vol_spike: boolean };
  volatility_regime: { regime: string; min_rr: number; entry_k: number; sl_k: number };
  smc?: SmcContext;
  base_math?: { long: TradePlan | Record<string, never>; short: TradePlan | Record<string, never> };
}

// computeIndicators() has no generic "trend" field — only "supertrend" (BUY/SELL/NEUTRAL),
// "macd_trend" (string label), and "market_structure"/"bos_signal". Use supertrend as the
// binary directional signal instead of reading a "trend" key that doesn't exist.
function superTrendToDirection(st: unknown): Direction {
  const s = String(st ?? "").trim().toUpperCase();
  if (s === "BUY") return "Long";
  if (s === "SELL") return "Short";
  return "Neutral";
}

function macdVals(ind: Record<string, any>): [number, number] {
  const extract = (val: unknown) => {
    if (Array.isArray(val)) return val.length ? sf(val[val.length - 1], 0) : 0;
    return sf(val, 0);
  };
  return [extract(ind?.macd), extract(ind?.macd_signal)];
}

function distanceTol(symbol: string, px: number): number {
  const s = (symbol || "").toUpperCase().replace("/", "");
  const price = sf(px, 1);
  if (s.includes("XAU") || s.includes("GOLD")) return Math.max(0.8, price * 0.00015);
  if (s.includes("JPY")) return Math.max(0.03, price * 0.00015);
  return Math.max(0.0007, price * 0.00015);
}

function detectEqualLevels(levels: number[], symbol: string, px: number): boolean {
  const vals = [...(levels || [])].sort((a, b) => a - b);
  if (vals.length < 2) return false;
  const tol = distanceTol(symbol, px);
  for (let i = 0; i < vals.length - 1; i++) {
    if (Math.abs(vals[i + 1] - vals[i]) <= tol) return true;
  }
  return false;
}

function internalTpLong(resLevels: number[], entry: number, fallbackTp: number): number {
  const candidates = (resLevels || []).filter((x) => x > entry);
  return candidates.length ? candidates[0] : fallbackTp;
}

function internalTpShort(supLevels: number[], entry: number, fallbackTp: number): number {
  const candidates = (supLevels || []).filter((x) => x < entry);
  return candidates.length ? candidates[candidates.length - 1] : fallbackTp;
}

export async function prepareMarketContext(
  symbol: string,
  interval: string,
  candles: Candle[],
  livePriceIn: number | null = null,
  allData?: Record<string, Candle[]>,
  indicatorCache?: Record<string, any>
): Promise<MarketContext> {
  const closes = candles.map((c) => sf(c.close));
  const highs = candles.map((c) => sf(c.high));
  const lows = candles.map((c) => sf(c.low));
  const priceLatest = closes.length ? closes[closes.length - 1] : 0;

  let refPrice = sf(livePriceIn, 0);
  if (refPrice <= 0) refPrice = sf(priceLatest, 0);

  const anchorTfKey = normalizeTf(interval);
  const indicators = indicatorCache && indicatorCache[anchorTfKey]
    ? indicatorCache[anchorTfKey]
    : computeIndicators(candles);
  if (indicatorCache) indicatorCache[anchorTfKey] = indicators;
  const atr = sf(indicators?.atr, 0);

  // News integration deferred — stub for now
  const newsSummary = "No news available.";

  const allRes = normalizeLevels(indicators?.resistance_levels_all ?? indicators?.resistance_levels ?? []);
  const allSup = normalizeLevels(indicators?.support_levels_all ?? indicators?.support_levels ?? []);

  const resLevelsTop3 = nearestLevels(allRes, refPrice, "above", 3);
  const supLevelsTop3 = nearestLevels(allSup, refPrice, "below", 3);

  // Premium / discount
  const lookback = 120;
  const rangeHigh = highs.length >= lookback ? Math.max(...highs.slice(-lookback)) : highs.length ? Math.max(...highs) : refPrice;
  const rangeLow = lows.length >= lookback ? Math.min(...lows.slice(-lookback)) : lows.length ? Math.min(...lows) : refPrice;
  const denom = Math.max(1e-9, rangeHigh - rangeLow);
  const loc = clamp((refPrice - rangeLow) / denom, 0, 1);
  const locationLabel = loc <= 0.33 ? "Discount" : loc >= 0.67 ? "Premium" : "Mid-Range";
  const noTradeZone = loc > 0.36 && loc < 0.64;

  // Multi-timeframe alignment
  const intervalNorm = normalizeTf(interval);
  const tfs = Array.from(new Set([intervalNorm, "15m", "1h", "4h", "1d"].filter(Boolean)));
  const multiTf: Record<string, Record<string, any>> = {};

  // Normalize allData's keys once so lookups below match regardless of how
  // the caller named its timeframes (e.g. "1h" vs "60m").
  const normalizedAllData: Record<string, Candle[]> = {};
  if (allData) {
    for (const [k, v] of Object.entries(allData)) normalizedAllData[normalizeTf(k)] = v;
  }

  for (const tf of tfs) {
    try {
      // Reuse already-fetched candles when the caller supplied them (e.g.
      // snapshotService.ts passes the full multi-tf set it just fetched) —
      // avoids re-hitting Yahoo Finance and re-running computeIndicators()
      // for data we already have in memory. Only fetch fresh when a
      // timeframe is genuinely missing (e.g. single-candle callers like
      // /api/predict, which intentionally still fetch their own MTF data).
      if (indicatorCache && indicatorCache[tf]) {
        multiTf[tf] = indicatorCache[tf];
        continue;
      }
      const cached = normalizedAllData[tf];
      if (!cached?.length) throw new Error(`Missing saved candles for ${symbol} ${tf}`);
      const tfCandles = cached;
      multiTf[tf] = tfCandles && tfCandles.length ? computeIndicators(tfCandles) : {};
      if (indicatorCache) indicatorCache[tf] = multiTf[tf];
    } catch (e) {
      multiTf[tf] = {};
    }
  }

  const tfTrendScore = (indTf: Record<string, any>): number => {
    if (!indTf || indTf.error) return 0;
    let t = 0;
    const e200 = sf(indTf.ema_200 ?? indTf.EMA_200, 0);
    if (e200 > 0) t += refPrice > e200 ? 1 : -1;
    const r = sf(indTf.rsi ?? indTf.rsi_14, 50);
    if (r >= 55) t += 1;
    else if (r <= 45) t -= 1;
    const [ml, msig] = macdVals(indTf);
    if (ml > msig) t += 1;
    else if (ml < msig) t -= 1;
    return t;
  };

  const t1d = tfTrendScore(multiTf["1d"] || {});
  const t4h = tfTrendScore(multiTf["4h"] || {});
  const t1h = tfTrendScore(multiTf["1h"] || {});
  const alignmentRaw = 0.5 * t1d + 0.3 * t4h + 0.2 * t1h;
  const alignmentScore = clamp(alignmentRaw / 3.0, -1, 1);
  const htfBias: Direction = alignmentScore >= 0.25 ? "Long" : alignmentScore <= -0.25 ? "Short" : "Neutral";

  // Risk / volatility
  const equalHighs = detectEqualLevels(allRes.slice(0, 8), symbol, refPrice);
  const equalLows = detectEqualLevels(allSup.slice(0, 8), symbol, refPrice);

  const volClass = classifyVolatility(indicators, priceLatest);
  const regime = volClass.level.toLowerCase();

  let entryK: number, slK: number, minRr: number;
  if (isXau(symbol)) {
    if (regime.includes("high")) [entryK, slK, minRr] = [0.6, 0.85, 1.2];
    else if (regime.includes("low")) [entryK, slK, minRr] = [0.45, 0.6, 1.1];
    else [entryK, slK, minRr] = [0.55, 0.7, 1.2];
  } else {
    if (regime.includes("high")) [entryK, slK, minRr] = [0.35, 0.8, 1.5];
    else if (regime.includes("low")) [entryK, slK, minRr] = [0.2, 0.55, 1.3];
    else [entryK, slK, minRr] = [0.28, 0.65, 1.4];
  }

  // Entry plan
  const supertrendBias = superTrendToDirection(indicators?.supertrend);
  let bias: Direction = htfBias !== "Neutral" ? htfBias : supertrendBias;

  if ((bias === "Long" && loc > 0.72) || (bias === "Short" && loc < 0.28)) bias = "Neutral";
  if (noTradeZone && Math.abs(alignmentScore) < 0.55) bias = "Neutral";

  const entryPlan: MarketContext["entry_plan"] = {
    bias,
    entry_type: null,
    entry_price: null,
    stop_loss: null,
    take_profit: null,
    rr: 0,
  };

  const prec = isXau(symbol) ? 2 : symbol.toUpperCase().includes("JPY") ? 3 : 5;
  const nSup = nearestBelow(allSup, refPrice);
  const nRes = nearestAbove(allRes, refPrice);

  if (bias === "Long" && nSup !== null && atr > 0) {
    const entry = nSup + entryK * atr;
    const slp = nSup - slK * atr;
    const risk = Math.abs(entry - slp);
    const wallTp = nRes !== null ? nRes - 0.15 * atr : entry + minRr * risk;
    const internalTp = internalTpLong(resLevelsTop3, entry, wallTp);

    const tp = isXau(symbol)
      ? Math.min(wallTp, Math.max(entry + 1.2 * risk, internalTp ? internalTp - 0.1 * atr : wallTp))
      : Math.min(wallTp, Math.max(entry + minRr * risk, internalTp ? internalTp - 0.1 * atr : wallTp));

    const rr = Math.abs(tp - entry) / Math.max(1e-9, risk);

    if (rr >= minRr && slp < entry && entry < tp) {
      entryPlan.entry_type = "buy_limit";
      entryPlan.entry_price = Number(entry.toFixed(prec));
      entryPlan.stop_loss = Number(slp.toFixed(prec));
      entryPlan.take_profit = Number(tp.toFixed(prec));
      entryPlan.rr = Math.round(rr * 100) / 100;
    } else {
      entryPlan.bias = "Neutral";
    }
  } else if (bias === "Short" && nRes !== null && atr > 0) {
    const entry = nRes - entryK * atr;
    const slp = nRes + slK * atr;
    const risk = Math.abs(slp - entry);
    const wallTp = nSup !== null ? nSup + 0.15 * atr : entry - minRr * risk;
    const internalTp = internalTpShort(supLevelsTop3, entry, wallTp);

    const tp = isXau(symbol)
      ? Math.max(wallTp, Math.min(entry - 1.2 * risk, internalTp ? internalTp + 0.1 * atr : wallTp))
      : Math.max(wallTp, Math.min(entry - minRr * risk, internalTp ? internalTp + 0.1 * atr : wallTp));

    const rr = Math.abs(entry - tp) / Math.max(1e-9, risk);

    if (rr >= minRr && tp < entry && entry < slp) {
      entryPlan.entry_type = "sell_limit";
      entryPlan.entry_price = Number(entry.toFixed(prec));
      entryPlan.stop_loss = Number(slp.toFixed(prec));
      entryPlan.take_profit = Number(tp.toFixed(prec));
      entryPlan.rr = Math.round(rr * 100) / 100;
    } else {
      entryPlan.bias = "Neutral";
    }
  }

  // Final confidence
  let baseConf = 50 + alignmentScore * 30;
  if (noTradeZone) baseConf -= 12;
  if (equalHighs || equalLows) baseConf -= 5;
  if (bias === "Neutral") baseConf -= 8;
  const confidenceScore = Math.round(clamp(baseConf, 0, 100));

  return {
    symbol,
    price_latest: priceLatest,
    ref_price: refPrice,
    indicators,
    interval: intervalNorm,
    resistance_levels: resLevelsTop3,
    support_levels: supLevelsTop3,
    support_levels_all: allSup,
    resistance_levels_all: allRes,
    structure_location: { label: locationLabel, position_0_1: Math.round(loc * 100) / 100, no_trade_zone: noTradeZone },
    htf_alignment: { score: Math.round(alignmentScore * 100) / 100, bias: htfBias },
    entry_plan: entryPlan,
    confidence_score: confidenceScore,
    news_summary: newsSummary,
    multi_tf: multiTf,
    risk_flags: { equal_highs: equalHighs, equal_lows: equalLows, vol_spike: regime === "high" },
    volatility_regime: { regime, min_rr: minRr, entry_k: entryK, sl_k: slK },
  };
}

// ============================================================================
// buildDetailedPromptRoles — the AI prompt (system + user messages)
// ============================================================================

function fmtNum(v: number | null | undefined, symbol: string): string {
  if (v === null || v === undefined) return "None";
  if (isXau(symbol)) return v.toFixed(2);
  if (symbol.toUpperCase().includes("JPY")) return v.toFixed(3);
  return v.toFixed(5);
}

export function buildDetailedPromptRoles(
  context: MarketContext,
  livePrice: number | null
): { role: "system" | "user"; content: string }[] {
  const symbol = context.symbol || "N/A";
  const interval = context.interval || "N/A";

  const mtfLines: string[] = [];
  for (const tfKey of ["15m", "1h", "4h", "1d"]) {
    const tfData = context.multi_tf?.[tfKey];
    if (tfData && Object.keys(tfData).length) {
      const tRsi = Math.round(sf(tfData.rsi ?? tfData.rsi_14, 50) * 100) / 100;
      const tDir = superTrendToDirection(tfData.supertrend);
      const tTrend = tDir === "Long" ? "Bullish" : tDir === "Short" ? "Bearish" : "Neutral";
      mtfLines.push(`- ${tfKey}: RSI=${tRsi} | Trend=${tTrend}`);
    }
  }
  const mtfContextString = mtfLines.length ? mtfLines.join("\n") : "No MTF data available.";

  const indicators = context.indicators || {};
  const rsi = sf(indicators.rsi_14 ?? indicators.rsi, 50);
  const refPrice = sf(context.ref_price, sf(livePrice, sf(context.price_latest, 0)));

  const nearestSupport = nearestBelow(context.support_levels_all || [], refPrice);
  const nearestResistance = nearestAbove(context.resistance_levels_all || [], refPrice);

  const htf = context.htf_alignment;
  const struct = context.structure_location;
  const riskFlags = context.risk_flags;
  const volRegime = context.volatility_regime;
  const smc = context.smc;

  const priceVsEma = "Unknown"; // wire up if you want EMA200 shown explicitly

  const baseMath = context.base_math || { long: {}, short: {} };
  const baseLong = baseMath.long as TradePlan;
  const baseShort = baseMath.short as TradePlan;

  const snapshot = `
MARKET SNAPSHOT — ${symbol} (${interval})
REF PRICE: ${fmtNum(refPrice, symbol)}

MULTI-TIMEFRAME ANALYSIS:
${mtfContextString}

ALIGNMENT: ${htf?.bias ?? "Neutral"} (${htf ? Math.round(htf.score * 100) / 100 : 0}) | ${struct?.label ?? "Unknown"} | No-trade: ${struct?.no_trade_zone ?? false}
TECH: RSI=${Math.round(rsi * 100) / 100} | ATR=${sf(indicators.atr_14 ?? indicators.atr, 0).toFixed(3)} | EMA200=${priceVsEma}
STRUCTURE: nearest_support=${fmtNum(nearestSupport, symbol)} | nearest_resistance=${fmtNum(nearestResistance, symbol)}
RISK FLAGS: EqH=${riskFlags?.equal_highs ?? false} | EqL=${riskFlags?.equal_lows ?? false} | VolSpike=${riskFlags?.vol_spike ?? false}
SMC: bias=${smc?.smc_bias ?? "Neutral"} | pd_bias=${smc?.pd_bias ?? "Neutral"} | killzone=${smc?.killzone_active ?? false} ${smc?.killzone_label ?? ""} | bullish_sweep=${smc?.has_bullish_sweep ?? false} | bearish_sweep=${smc?.has_bearish_sweep ?? false} | BOS=${smc?.bos_count ?? 0} | CHOCH=${smc?.choch_count ?? 0}
VOL REGIME: ${volRegime?.regime ?? "medium"} | min_rr=${volRegime?.min_rr ?? 1.2}

BASE DUAL PLAN (SOURCE OF TRUTH):
- IF_LONG:  entry=${fmtNum(baseLong?.entry, symbol)} | sl=${fmtNum(baseLong?.stop_loss, symbol)} | tp=${fmtNum(baseLong?.take_profit, symbol)} | rr=${baseLong?.rr ?? 0} | trigger=${baseLong?.trigger ?? ""}
- IF_SHORT: entry=${fmtNum(baseShort?.entry, symbol)} | sl=${fmtNum(baseShort?.stop_loss, symbol)} | tp=${fmtNum(baseShort?.take_profit, symbol)} | rr=${baseShort?.rr ?? 0} | trigger=${baseShort?.trigger ?? ""}

NEWS/CALENDAR:
${context.news_summary ?? "No news available."}
`.trim();

  const systemMessage = {
    role: "system" as const,
    content: `
You are a Senior Forex Risk Officer. Output STRICT JSON only.

ROLE:
You are NOT generating trades from scratch.
You are reviewing Python-generated BASE DUAL PLAN setups and may only:
1) keep a setup unchanged,
2) refine a setup slightly,
3) veto a setup by setting entry=0.

PRIMARY OBJECTIVE:
Protect against bad entries, liquidity sweeps, front-running, and weak momentum alignment.

NON-NEGOTIABLE RULES:
1) BASELINE FIRST: Start from the provided BASE DUAL PLAN. Do not invent a new trade direction unless it is already present.
2) GEOMETRY: LONG must satisfy stop_loss < entry < take_profit. SHORT must satisfy take_profit < entry < stop_loss.
3) ENTRY DISCIPLINE: For sweep-prone markets like XAUUSD, prefer deeper entries rather than earlier entries.
4) TP DISCIPLINE: Do not push TP unrealistically far. Favor realistic exits near internal structure or front-run walls slightly.
5) RR: Final RR must stay >= ${context.volatility_regime?.min_rr ?? 1.2}. If a valid refinement is not possible, set that side's entry=0.
6) MOMENTUM VETO: If 15m/1h momentum is materially against a side, veto that side.
7) NO-TRADE FILTER: If the market is mid-range / no-trade and no strong confluence exists, veto both sides.
8) SMC FILTER: Sweeps, PD bias, BOS/CHOCH, and killzone should influence whether a side is kept or vetoed.
9) CONSERVATISM: Small refinements are preferred over large changes. Do not move entry/SL/TP excessively from the base plan.
10) STRICT OUTPUT: Return STRICT JSON only with no markdown and no explanation outside JSON.

REFINEMENT LIMITS:
- entry adjustment: preferably within 0.35 ATR of the base plan
- stop_loss adjustment: preferably within 0.35 ATR of the base plan
- take_profit adjustment: preferably within 0.75 ATR of the base plan
- if a larger move is needed, veto instead of forcing a bad setup

OUTPUT JSON SCHEMA:
{
  "symbol": "${symbol}",
  "preferred": "Long|Short|None",
  "if_long": { "type": "buy_limit", "entry": num, "stop_loss": num, "take_profit": num, "rr": num, "trigger": "str" },
  "if_short": { "type": "sell_limit", "entry": num, "stop_loss": num, "take_profit": num, "rr": num, "trigger": "str" },
  "reasoning": "short bullets",
  "notes": "short string"
}

IMPORTANT:
- If vetoing LONG, return if_long.entry = 0
- If vetoing SHORT, return if_short.entry = 0
- Keep numbers realistic for the symbol precision
- Never output market orders
- Never output both sides as preferred
`.trim(),
  };

  const userMessage = {
    role: "user" as const,
    content: `Review and refine this market snapshot conservatively:\n${snapshot}`,
  };

  return [systemMessage, userMessage];
}

// ============================================================================
// predictTrade — the main orchestrator
// ============================================================================
// Accepts either a single-timeframe candle array (anchor timeframe = `interval`)
// or a multi-timeframe map ({ "15m": [...], "1h": [...], ... }), matching the
// Python version's flexibility. Options.livePrice lets a caller pass in an
// already-fetched live price; otherwise it falls back to the last close of
// the anchor timeframe.

export async function predictTrade(
  ohlcIn: Candle[] | Record<string, Candle[]>,
  symbol: string,
  intervalIn: string,
  options: { skipAi?: boolean; livePrice?: number; indicatorCache?: Record<string, any> } = {}
): Promise<PredictionResult> {
  const trendFromCloses = (closes: number[]): Direction => {
    if (closes.length < 6) return "Neutral";
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 5];
    if (last > prev) return "Bullish" as Direction; // kept as-is for parity; used only as a loose signal below
    if (last < prev) return "Bearish" as Direction;
    return "Neutral";
  };

  const normalizeDirection = (x: string): Direction => {
    const s = String(x || "").trim().toLowerCase();
    if (["long", "bullish", "buy"].includes(s)) return "Long";
    if (["short", "bearish", "sell"].includes(s)) return "Short";
    return "Neutral";
  };

  let interval = normalizeTf(intervalIn);
  let allData: Record<string, Candle[]> | undefined;
  let candles: Candle[];

  if (Array.isArray(ohlcIn)) {
    candles = ohlcIn;
  } else {
    allData = ohlcIn;
    const anchorTf = ohlcIn[interval] ? interval : ohlcIn["1h"] ? "1h" : ohlcIn["15m"] ? "15m" : Object.keys(ohlcIn)[0];
    candles = ohlcIn[anchorTf];
    interval = normalizeTf(anchorTf);
  }

  const validIntervals = new Set(["15m", "1h", "4h", "1d"]);
  if (!validIntervals.has(interval)) {
    return {
      direction: "Neutral",
      confidence_score: 0,
      trade_strength: "⚪ Neutral",
      live_price: null,
      market_state: "Neutral",
      preferred: "None",
      long_setup: {},
      short_setup: {},
      reasoning: `Invalid interval: ${interval}. Use one of 15m, 1h, 4h, 1d`,
      notes: "",
      ai_raw: {},
    };
  }

  if (!validateOhlc(candles)) {
    return {
      direction: "Neutral",
      confidence_score: 0,
      trade_strength: "⚪ Neutral",
      live_price: null,
      market_state: "Neutral",
      preferred: "None",
      long_setup: {},
      short_setup: {},
      reasoning: "Not enough OHLC data.",
      notes: "",
      ai_raw: {},
    };
  }

  // Live price — no cache to fall back on, just use the last close or an
  // explicitly passed-in value from the caller (e.g. a fresher tick).
  let livePrice = options.livePrice ?? candles[candles.length - 1].close;
  livePrice = sf(livePrice, 0);
  if (livePrice <= 0) {
    return {
      direction: "Neutral",
      confidence_score: 0,
      trade_strength: "⚪ Neutral",
      live_price: null,
      market_state: "Neutral",
      preferred: "None",
      long_setup: {},
      short_setup: {},
      reasoning: "Could not resolve live price.",
      notes: "",
      ai_raw: {},
    };
  }

  const ohlcClosed = candles.length > 1 ? candles.slice(0, -1) : candles;

  let context: MarketContext;
  try {
    context = await prepareMarketContext(symbol, interval, ohlcClosed, livePrice, allData, options.indicatorCache);
  } catch (e) {
    console.error("❌ Context preparation failed:", e);
    context = {} as MarketContext;
  }

  let smcContext: SmcContext;
  try {
    smcContext = await getSmcContext(symbol, interval, ohlcClosed, allData);
  } catch (e) {
    console.error("❌ SMC context failed:", e);
    smcContext = {
      pd_bias: "Neutral",
      killzone_active: false,
      killzone_label: "",
      has_bullish_sweep: false,
      has_bearish_sweep: false,
      bos_count: 0,
      choch_count: 0,
      smc_bias: "Neutral",
      notes: [],
    };
  }
  context.smc = smcContext;

  // Supplemental MTF processing — fill in any timeframe missing from context.multi_tf
  const multiTfContext = context.multi_tf || {};
  const multiTfProcessed: Record<string, { rsi: number; trend: Direction }> = {};

  if (allData) {
    for (const [tfName, tfCandles] of Object.entries(allData)) {
      const tfNorm = normalizeTf(tfName);
      if (tfCandles && tfCandles.length > 14) {
        const closes = tfCandles.map((c) => sf(c.close)).filter((c) => c > 0);
        if (closes.length < 15) continue;
        const currentRsi = sf(context.indicators?.rsi_14 ?? context.indicators?.rsi, 50);
        multiTfProcessed[tfNorm] = { rsi: Math.round(currentRsi * 100) / 100, trend: trendFromCloses(closes) };
      }
    }
  }

  const mergedMultiTf: Record<string, any> = {};
  for (const tf of new Set([...Object.keys(multiTfContext), ...Object.keys(multiTfProcessed)])) {
    const baseTf = multiTfContext[tf] || {};
    const procTf = multiTfProcessed[tf] || {};
    mergedMultiTf[tf] = { ...baseTf };
    for (const [k, v] of Object.entries(procTf)) {
      if (!(k in mergedMultiTf[tf]) || [null, "", 0].includes(mergedMultiTf[tf][k])) {
        mergedMultiTf[tf][k] = v;
      }
    }
  }
  context.multi_tf = mergedMultiTf;

  const indicators = context.indicators || {};
  const entryPlan = context.entry_plan || ({} as MarketContext["entry_plan"]);
  const structLoc = context.structure_location || ({} as MarketContext["structure_location"]);
  const htf = context.htf_alignment || ({ score: 0, bias: "Neutral" } as MarketContext["htf_alignment"]);
  const riskFlags = context.risk_flags || ({} as MarketContext["risk_flags"]);

  const smc = context.smc;
  const smcBias = smc?.smc_bias ?? "Neutral";
  const pdBias = smc?.pd_bias ?? "Neutral";
  const killzoneActive = smc?.killzone_active ?? false;
  const killzoneLabel = smc?.killzone_label ?? "";
  const hasBullishSweep = smc?.has_bullish_sweep ?? false;
  const hasBearishSweep = smc?.has_bearish_sweep ?? false;
  const bosCount = smc?.bos_count ?? 0;
  const chochCount = smc?.choch_count ?? 0;

  const rsi = sf(indicators.rsi_14 ?? indicators.rsi, 50);
  const atr = sf(indicators.atr_14 ?? indicators.atr, 0);
  const ema200 = sf(indicators.EMA_200 ?? indicators.ema_200, livePrice);

  let resLevels = normalizeLevels(context.resistance_levels_all ?? context.resistance_levels ?? []);
  let supLevels = normalizeLevels(context.support_levels_all ?? context.support_levels ?? []);

  const maxDistance = atr > 0 ? atr * 12 : Infinity;
  supLevels = supLevels.filter((s) => Math.abs(livePrice - s) <= maxDistance);
  resLevels = resLevels.filter((r) => Math.abs(livePrice - r) <= maxDistance);

  const plannedBias = normalizeDirection(entryPlan.bias);
  const plannedEntry = sf(entryPlan.entry_price, 0);
  const plannedSl = sf(entryPlan.stop_loss, 0);
  const plannedTp = sf(entryPlan.take_profit, 0);
  const plannedRr = sf(entryPlan.rr, 0);

  const noTradeZone = structLoc.no_trade_zone ?? false;
  const htfScore = sf(htf.score, 0);
  const htfBias = normalizeDirection(htf.bias);
  const minRr = sf(context.volatility_regime?.min_rr, 1.2);

  // Working recommendation
  let recommendation: Direction = "Neutral";
  if ((plannedBias === "Long" || plannedBias === "Short") && plannedEntry > 0) {
    recommendation = plannedBias;
  }

  const m15Data = mergedMultiTf["15m"] || {};
  const m15Trend = superTrendToDirection(m15Data.supertrend);
  const m15Rsi = sf(m15Data.rsi, 50);

  let preferred: Preferred = "None";
  if (Math.abs(htfScore) >= 0.6) {
    preferred = htfScore > 0 ? "Long" : "Short";
  } else if (m15Trend === "Long" || m15Trend === "Short") {
    preferred = m15Trend;
  }

  // Hard tactical vetoes
  if (recommendation !== "Neutral") {
    if (noTradeZone && Math.abs(htfScore) < 0.6) recommendation = "Neutral";
    if (recommendation === "Long" && livePrice < ema200 && m15Rsi > 35) recommendation = "Neutral";
    if (recommendation === "Short" && livePrice > ema200 && m15Rsi < 65) recommendation = "Neutral";
  }

  // SMC gating
  if (recommendation === "Long") {
    if (smcBias === "Bearish") {
      recommendation = "Neutral";
    } else if (pdBias === "Bullish" || hasBullishSweep) {
      preferred = "Long";
    }
  } else if (recommendation === "Short") {
    if (smcBias === "Bullish") {
      recommendation = "Neutral";
    } else if (pdBias === "Bearish" || hasBearishSweep) {
      preferred = "Short";
    }
  }

  if (isXau(symbol)) {
    if (recommendation === "Long" && !(hasBullishSweep || pdBias === "Bullish" || bosCount > chochCount)) {
      recommendation = "Neutral";
    } else if (recommendation === "Short" && !(hasBearishSweep || pdBias === "Bearish" || chochCount > bosCount)) {
      recommendation = "Neutral";
    }
  }

  // Multi-timeframe conflict check
  let tfConflicts = 0;
  if (recommendation === "Long" || recommendation === "Short") {
    for (const tf of ["1h", "4h", "1d"]) {
      const tfR = sf(mergedMultiTf[tf]?.rsi, 50);
      if (recommendation === "Long" && tfR < 45) tfConflicts += 1;
      if (recommendation === "Short" && tfR > 55) tfConflicts += 1;
    }
  }
  if (tfConflicts >= 2) recommendation = "Neutral";

  // Base deterministic setups
  const { long: baseLongRaw, short: baseShortRaw } = buildDualLimitSetups(
    livePrice,
    atr,
    supLevels,
    resLevels,
    minRr,
    symbol
  );

  let longSetup = normalizeTradePlan(baseLongRaw, symbol, livePrice);
  let shortSetup = normalizeTradePlan(baseShortRaw, symbol, livePrice);

  if (!validateTrade(longSetup, minRr)) longSetup = {};
  if (!validateTrade(shortSetup, minRr)) shortSetup = {};

  // Strategy-engine override only if valid
  if (plannedBias === "Long" && plannedEntry > 0) {
    const candidate = normalizeTradePlan(
      {
        type: "buy_limit",
        entry: plannedEntry,
        stop_loss: plannedSl,
        take_profit: plannedTp,
        rr: plannedRr,
        trigger: entryPlan.entry_type ? "Strategy engine long setup" : "Strategy engine long setup",
      },
      symbol,
      livePrice
    );
    if (validateTrade(candidate, minRr)) longSetup = candidate;
  } else if (plannedBias === "Short" && plannedEntry > 0) {
    const candidate = normalizeTradePlan(
      {
        type: "sell_limit",
        entry: plannedEntry,
        stop_loss: plannedSl,
        take_profit: plannedTp,
        rr: plannedRr,
        trigger: "Strategy engine short setup",
      },
      symbol,
      livePrice
    );
    if (validateTrade(candidate, minRr)) shortSetup = candidate;
  }

  context.base_math = { long: longSetup, short: shortSetup };

  // AI refinement
  let aiFinalLong: TradePlan | Record<string, never> = { ...(longSetup as TradePlan) };
  let aiFinalShort: TradePlan | Record<string, never> = { ...(shortSetup as TradePlan) };
  let aiReasoning = "Using base technical levels (Calculated via SMC/Price Action).";
  let aiNotes = "AI refinement skipped.";
  let aiRawResponse: Record<string, any> = {};

  aiNotes = "AI refinement skipped (skipAi flag active).";

  // Final safety validation — never trust anything, AI or otherwise, past this point
  if (!validateTrade(aiFinalLong, minRr)) aiFinalLong = {};
  if (!validateTrade(aiFinalShort, minRr)) aiFinalShort = {};

  // Direction cleanup based on surviving setups
  if (recommendation === "Long" && !("entry" in aiFinalLong)) recommendation = "Neutral";
  if (recommendation === "Short" && !("entry" in aiFinalShort)) recommendation = "Neutral";

  if (preferred === "Long" && !("entry" in aiFinalLong)) {
    preferred = "entry" in aiFinalShort ? "Short" : "None";
  } else if (preferred === "Short" && !("entry" in aiFinalShort)) {
    preferred = "entry" in aiFinalLong ? "Long" : "None";
  } else if (preferred === "None") {
    if ("entry" in aiFinalLong && !("entry" in aiFinalShort)) preferred = "Long";
    else if ("entry" in aiFinalShort && !("entry" in aiFinalLong)) preferred = "Short";
  }

  // Reasoning + confidence
  const ctxLines = [
    `• HTF Bias: ${htfBias} (${Math.round(htfScore * 100) / 100})`,
    `• RSI: ${Math.round(rsi * 100) / 100} | ATR: ${atr.toFixed(5)}`,
    `• EMA 200: ${livePrice > ema200 ? "Above" : "Below"}`,
    `• Preferred: ${preferred}`,
    `• SMC Bias: ${smcBias} | PD Bias: ${pdBias}`,
    `• Killzone: ${killzoneActive ? "Active" : "Inactive"} ${killzoneLabel}`.trim(),
    `• Sweeps: Bullish=${hasBullishSweep} | Bearish=${hasBearishSweep}`,
    `• Equal Highs: ${riskFlags.equal_highs ?? false} | Equal Lows: ${riskFlags.equal_lows ?? false}`,
  ];
  if (tfConflicts > 0) ctxLines.push(`⚠️ MTF Conflict: ${tfConflicts} levels.`);

  const baseConf = Math.round(sf(context.confidence_score, 50));
  let finalConf = Math.round(clamp(baseConf - tfConflicts * 8, 10, 95));

  if (recommendation === "Long") {
    if (pdBias === "Bullish") finalConf += 4;
    if (hasBullishSweep) finalConf += 6;
    if (killzoneActive) finalConf += 3;
    if (bosCount > chochCount) finalConf += 3;
  } else if (recommendation === "Short") {
    if (pdBias === "Bearish") finalConf += 4;
    if (hasBearishSweep) finalConf += 6;
    if (killzoneActive) finalConf += 3;
    if (chochCount > bosCount) finalConf += 3;
  }
  if (recommendation === "Neutral") finalConf = Math.min(finalConf, 55);
  finalConf = Math.round(clamp(finalConf, 10, 95));

  let tradeStrength = "⚪ Neutral";
  if (recommendation !== "Neutral" && finalConf >= 70) tradeStrength = "🟢 Strong";
  else if (recommendation !== "Neutral") tradeStrength = "🟡 Moderate";

  return {
    direction: recommendation,
    confidence_score: finalConf,
    trade_strength: tradeStrength,
    live_price: roundPx(livePrice, symbol),
    market_state: htfScore > 0.25 ? "Bullish" : htfScore < -0.25 ? "Bearish" : "Neutral",
    preferred,
    long_setup: aiFinalLong,
    short_setup: aiFinalShort,
    reasoning: `${aiReasoning}\n\nContext:\n${ctxLines.join("\n")}`,
    notes: aiNotes,
    ai_raw: aiRawResponse,
  };
}
