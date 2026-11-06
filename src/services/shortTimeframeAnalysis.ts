import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { computeShortTimeframeSnapshot } from './analysisEngine';
import type { Candle } from './candleTypes';
import { TIER_CONFIG, type Tier } from './snapshotConfig';

export const SHORT_TIMEFRAMES = ['1m', '5m'] as const;
type ShortFrame = typeof SHORT_TIMEFRAMES[number];
const SECONDS = { '1m': 60, '5m': 300 };
const MAX_AGE_MS = { '1m': 180_000, '5m': 750_000 };
type Outcome = { pair: string; ok: boolean; published?: boolean; skipped?: boolean; error?: string; timeframes?: string[] };

function errorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
}

export function validateShortCandles(tf: ShortFrame, candles: Candle[], now = Date.now()) {
  if (!Array.isArray(candles) || candles.length < 200 || candles.length > 250) {
    throw new Error(`${tf}: need 200-250 closed candles for EMA200`);
  }
  let previous = 0;
  for (const c of candles) {
    if (!c || !Number.isSafeInteger(c.timestamp) || c.timestamp <= previous || c.timestamp % SECONDS[tf] !== 0 ||
      ![c.open,c.high,c.low,c.close].every(n => Number.isFinite(n) && n > 0) ||
      c.high < Math.max(c.open,c.close,c.low) || c.low > Math.min(c.open,c.close) ||
      (c.timestamp + SECONDS[tf]) * 1000 > now) throw new Error(`${tf}: malformed, unordered or still-open Deriv candle`);
    previous = c.timestamp;
  }
  if (now - previous * 1000 > MAX_AGE_MS[tf]) throw new Error(`${tf}: Deriv candles are stale`);
  return previous;
}

export async function runPendingShortAnalysis(dryRun = true, tier?: Tier) {
  const db = getSupabaseAdmin();
  const outcomes: Outcome[] = [];
  const unavailable: Array<{ pair: string; timeframe: string; reason: string }> = [];
  try {
    // Read only source timestamps and compact publication markers. Never
    // download the listener's 2,000-bar JSON caches to discover pending work.
    const [sources, snapshots] = await Promise.all([
      db.from('market_candle_cache').select('pair,timeframe,source_candle_at').in('timeframe', [...SHORT_TIMEFRAMES]),
      db.from('market_snapshots').select('pair,short_analysis_sources'),
    ]);
    if (sources.error || snapshots.error) throw new Error(sources.error?.message || snapshots.error?.message);
    const done = new Map((Array.isArray(snapshots.data) ? snapshots.data : []).map(row => [row.pair, row.short_analysis_sources ?? {}]));
    const allowed = new Set(tier ? [...TIER_CONFIG[tier].pairs] : Object.values(TIER_CONFIG).flatMap(config => [...config.pairs]));
    const pending = new Set<string>();
    const seen = new Set<string>();
    const now = Date.now();
    for (const row of Array.isArray(sources.data) ? sources.data : []) {
      if (!allowed.has(row.pair) || !SHORT_TIMEFRAMES.includes(row.timeframe as ShortFrame)) continue;
      const tf = row.timeframe as ShortFrame;
      seen.add(`${row.pair}:${tf}`);
      const epoch = Date.parse(row.source_candle_at ?? '') / 1000;
      if (!Number.isFinite(epoch) || (epoch + SECONDS[tf]) * 1000 > now || now - epoch * 1000 > MAX_AGE_MS[tf]) {
        unavailable.push({ pair: row.pair, timeframe: tf, reason: 'Saved Deriv candles are stale or incomplete' });
      } else if (epoch > Number(done.get(row.pair)?.[tf] ?? 0)) pending.add(row.pair);
    }
    for (const pair of allowed) for (const tf of SHORT_TIMEFRAMES) {
      if (!seen.has(`${pair}:${tf}`)) unavailable.push({ pair, timeframe: tf, reason: 'No saved Deriv candles' });
    }
    console.info('[short-analysis-pending]', { count: pending.size, dryRun });
    async function analyse(pair: string): Promise<Outcome> {
      try {
        const { data: bundle, error } = await db.rpc('get_short_analysis_bundle', { p_pair: pair });
        if (error) throw error;
        if (!bundle || typeof bundle !== 'object') throw new Error('Missing saved Deriv analysis bundle');
        const windows: Record<string, Candle[]> = {};
        const versions: Record<string, number> = {};
        for (const tf of SHORT_TIMEFRAMES) {
          const bars = bundle.candles?.[tf];
          try {
            versions[tf] = validateShortCandles(tf, bars);
            windows[tf] = bars;
          } catch (error) {
            unavailable.push({ pair, timeframe: tf, reason: errorMessage(error) });
          }
        }
        if (!Object.keys(windows).length) return { pair, ok: true, skipped: true, timeframes: [] };
        const analysis = await computeShortTimeframeSnapshot(pair, windows, bundle.higher_indicators ?? {});
        if (dryRun) return { pair, ok: true, skipped: false, timeframes: Object.keys(windows) };
        const { data: published, error: writeError } = await db.rpc('publish_short_timeframe_analysis', {
          p_pair: pair, p_sources: versions, p_analysis: analysis,
        });
        if (writeError) throw writeError;
        console.info('[short-analysis-published]', { pair, timeframes: Object.keys(windows), published: published === true });
        return { pair, ok: true, published: published === true, skipped: published !== true, timeframes: Object.keys(windows) };
      } catch (error) {
        console.error('[short-analysis-failed]', { pair, error: errorMessage(error) });
        return { pair, ok: false, error: errorMessage(error) };
      }
    }
    const pairs = [...pending];
    for (let i = 0; i < pairs.length; i += 3) outcomes.push(...await Promise.all(pairs.slice(i,i+3).map(analyse)));
  } catch (error) {
    outcomes.push({ pair: 'short_timeframes', ok: false, error: errorMessage(error) });
  }
  return { total: outcomes.length, succeeded: outcomes.filter(row => row.ok).length,
    failed: outcomes.filter(row => !row.ok), results: outcomes, unavailable };
}
