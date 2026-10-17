// One job processes each pair across all four timeframes. Keep these tier IDs
// identical in forex, forex-cron and forex-analysers. Timers live in cron-job.org.
// Existing tiers retain their cadence; new crosses use four small 15-minute jobs.
import { INSTRUMENTS } from "./instruments";
export const ALL_PAIRS = [...INSTRUMENTS];
export const CORE_PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"];
export const EXTENDED_PAIRS_A = ["USDCAD", "AUDUSD", "USDCHF"];
export const EXTENDED_PAIRS_B = ["NZDUSD", "GBPJPY", "XAGUSD"];
export const EXTENDED_PAIRS_C = ["CPPER", "PLTUM", "PALDM"];
export const EXTENDED_PAIRS_D = ["EURJPY", "EURGBP", "AUDJPY"];
export const EXTENDED_PAIRS_E = ["EURAUD", "GBPAUD", "EURCHF"];
export const EXTENDED_PAIRS_F = ["CADJPY", "CHFJPY", "AUDCAD"];
export const EXTENDED_PAIRS_G = ["NZDJPY"];
export const EXTENDED_PAIRS = [
  ...EXTENDED_PAIRS_A, ...EXTENDED_PAIRS_B, ...EXTENDED_PAIRS_C,
  ...EXTENDED_PAIRS_D, ...EXTENDED_PAIRS_E, ...EXTENDED_PAIRS_F, ...EXTENDED_PAIRS_G,
];
export const TIER_CONFIG = {
  core: { pairs: CORE_PAIRS, refreshMinutes: 5, staggerMs: 400 },
  extended_a: { pairs: EXTENDED_PAIRS_A, refreshMinutes: 15, staggerMs: 400 },
  extended_b: { pairs: EXTENDED_PAIRS_B, refreshMinutes: 15, staggerMs: 400 },
  extended_c: { pairs: EXTENDED_PAIRS_C, refreshMinutes: 15, staggerMs: 400 },
  extended_d: { pairs: EXTENDED_PAIRS_D, refreshMinutes: 15, staggerMs: 400 },
  extended_e: { pairs: EXTENDED_PAIRS_E, refreshMinutes: 15, staggerMs: 400 },
  extended_f: { pairs: EXTENDED_PAIRS_F, refreshMinutes: 15, staggerMs: 400 },
  extended_g: { pairs: EXTENDED_PAIRS_G, refreshMinutes: 15, staggerMs: 400 },
} as const;
export type Tier = keyof typeof TIER_CONFIG;
export const SNAPSHOT_TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;
export const ANCHOR_INTERVAL = "4h";
export const STALE_MULTIPLIER = 2.5;
