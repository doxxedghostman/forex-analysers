// src/services/snapshotConfig.ts
//
// Tiers pairs by how often they're actually queried, not by timeframe.
// Reason: predictTrade() needs 15m/1h/4h/1d candles for ONE pair together (for
// HTF alignment + MTF conflict checks) — so the atomic cron unit is "refresh
// this pair across all its timeframes", not "refresh this one timeframe".
// Splitting by timeframe instead would mean re-fetching all 4 intervals
// anyway just to get one, which wastes Yahoo Finance calls for nothing.
//
// Adjust CORE_PAIRS based on what your users actually ask about most —
// wire this up to real usage stats (aiQuota.ts / your logs table) later
// instead of a hardcoded list, per the "don't snapshot dead pairs" idea.
//
// Extended tier is split into three smaller batches (A/B/C) rather than one
// 9-pair batch. runSnapshotForPair fetches 4 timeframes sequentially with a
// 150ms sleep between each, and runSnapshotBatch staggers pairs by another
// 400ms — deliberately serial to stay polite to Yahoo Finance. At 9 pairs
// in one batch that would add up to ~26-36s, which sits right on top of
// cron-job.org's free-tier 30s job timeout: Vercel would still finish fine
// (maxDuration is 60s) and the snapshot would still get written, but
// cron-job.org would log the run as failed anyway and auto-disable the job
// after 15 failures. Splitting into three ~8-11s batches keeps every run
// comfortably under that cap AND lets each batch run every 15min instead
// of 20min — see the note above EXTENDED_PAIRS_A for why 15min matters.

import { INSTRUMENTS } from "./instruments";

export const ALL_PAIRS = [...INSTRUMENTS];

// Frequently-asked majors + gold — refreshed tightly.
export const CORE_PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"];

// Everything else — refreshed less often, still enough to never look "dead".
// Split into THREE batches of 3 pairs each (was 2 batches of ~4-5) so every
// run finishes fast enough to schedule at 15min instead of 20min. At 20min,
// a 15m candle could fully close and start a new one before the next
// refresh landed, making the 15m analysis look stale/wrong to users vs. the
// live market — this was exactly that bug. 3 pairs sequential (4 timeframes
// each, 150ms sleep between + 400ms pair stagger) finishes well under 30s.
export const EXTENDED_PAIRS_A = ["USDCAD", "AUDUSD", "USDCHF"];
export const EXTENDED_PAIRS_B = ["NZDUSD", "GBPJPY", "XAGUSD"];
export const EXTENDED_PAIRS_C = ["CPPER", "PLTUM", "PALDM"];

// Kept for anything that still wants "all non-core pairs" as one list
// (e.g. display purposes) — not used as a single cron batch anymore.
export const EXTENDED_PAIRS = [...EXTENDED_PAIRS_A, ...EXTENDED_PAIRS_B, ...EXTENDED_PAIRS_C];

export const TIER_CONFIG = {
  core: {
    pairs: CORE_PAIRS,
    refreshMinutes: 5,
    // Small delay between each pair's fetch batch to stay polite to Yahoo.
    staggerMs: 400,
  },
  extended_a: {
    pairs: EXTENDED_PAIRS_A,
    refreshMinutes: 15,
    staggerMs: 400,
  },
  extended_b: {
    pairs: EXTENDED_PAIRS_B,
    refreshMinutes: 15,
    staggerMs: 400,
  },
  extended_c: {
    pairs: EXTENDED_PAIRS_C,
    refreshMinutes: 15,
    staggerMs: 400,
  },
} as const;

export type Tier = keyof typeof TIER_CONFIG;

// Timeframes fetched together per pair, per predictTrade()'s multi-tf expectation.
export const SNAPSHOT_TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;

// The interval predictTrade() anchors its final recommendation on when given
// multi-tf data. Matches what the app already surfaces to users (4h).
export const ANCHOR_INTERVAL = "4h";

// Snapshot considered stale if not refreshed within this many multiples of
// its tier's expected refresh interval — protects against a Yahoo rate-limit
// or silent fetch failure being presented to the AI/user as fresh data.
export const STALE_MULTIPLIER = 2.5;
