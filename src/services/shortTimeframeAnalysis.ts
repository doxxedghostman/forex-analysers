import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { computeShortTimeframeSnapshot } from './analysisEngine';
import type { Candle } from './candleTypes';
import { TIER_CONFIG, type Tier } from './snapshotConfig';
import { getD1CandleBundle, mapWithConcurrency } from './d1MarketData';

export const SHORT_TIMEFRAMES = ['1m', '5m'] as const;
type ShortFrame = typeof SHORT_TIMEFRAMES[number];
const SECONDS = { '1m': 60, '5m': 300 };
const MAX_AGE_MS = { '1m': 180_000, '5m': 750_000 };
type Outcome = { pair: string; ok: boolean; published?: boolean; skipped?: boolean; error?: string; timeframes?: string[] };
function errorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
}
export function validateShortCandles(tf: ShortFrame, candles: Candle[], now = Date.now()) {
  if (!Array.isArray(candles) || candles.length < 200 || candles.length > 250) throw new Error(`${tf}: need 200-250 closed candles for EMA200`);
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
type PublishedSources = { pair: string; short_analysis_sources?: Record<string, number> | null; multi_tf?: Record<string, any> | null };
function higherIndicators(multiTf: Record<string, any> | null | undefined) {
  const result: Record<string, unknown> = {};
  for (const tf of ['15m','1h','4h','1d']) {
    const indicators = multiTf?.[tf]?.indicators;
    if (indicators) result[tf] = {
      ema_200: indicators.ema_200, rsi: indicators.rsi,
      macd: Array.isArray(indicators.macd) ? indicators.macd.at(-1) : indicators.macd,
      macd_signal: Array.isArray(indicators.macd_signal) ? indicators.macd_signal.at(-1) : indicators.macd_signal,
      supertrend: indicators.supertrend,
    };
  }
  return result;
}
export async function runPendingShortAnalysis(dryRun = true, tier?: Tier, knownSnapshots?: PublishedSources[]) {
  const db = getSupabaseAdmin();
  const outcomes: Outcome[] = [];
  const unavailable: Array<{ pair: string; timeframe: string; reason: string }> = [];
  try {
    const [snapshotResult] = await Promise.all([
      knownSnapshots === undefined
        ? db.from('market_snapshots').select('pair,short_analysis_sources,multi_tf')
        : Promise.resolve({ data: knownSnapshots, error: null }),
    ]);
    if (snapshotResult.error) throw new Error(snapshotResult.error.message);
    const snapshots = Array.isArray(snapshotResult.data) ? snapshotResult.data : [];
    const snapshotByPair = new Map(snapshots.map(row => [row.pair, row]));
    const allowed = [...new Set(tier ? [...TIER_CONFIG[tier].pairs] : Object.values(TIER_CONFIG).flatMap(config => [...config.pairs]))];
    const requested = allowed.flatMap(pair => SHORT_TIMEFRAMES.map(timeframe => ({ pair, timeframe })));
    const bundles = await mapWithConcurrency(requested, 8, async item => {
      try { return { ...item, result: await getD1CandleBundle(item.pair, item.timeframe), error: null as string | null }; }
      catch (error) { return { ...item, result: null, error: errorMessage(error) }; }
    });
    const windowsByPair = new Map<string, Record<string, Candle[]>>();
    const contextByPair = new Map<string, Record<string, Candle[]>>();
    const versionsByPair = new Map<string, Record<string, number>>();
    const pending = new Set<string>();
    const seen = new Set<string>();
    const now = Date.now();
    for (const item of bundles) {
      const key = `${item.pair}:${item.timeframe}`;
      seen.add(key);
      if (item.error || !item.result) { unavailable.push({ pair: item.pair, timeframe: item.timeframe, reason: item.error || 'D1 candle response unavailable' }); continue; }
      const bars = Array.isArray(item.result.candles) ? item.result.candles.slice(-250) : [];
      try {
        const source = validateShortCandles(item.timeframe, bars, now);
        const done = Number(snapshotByPair.get(item.pair)?.short_analysis_sources?.[item.timeframe] ?? 0);
        const context = contextByPair.get(item.pair) ?? {}; context[item.timeframe] = bars; contextByPair.set(item.pair, context);
        if (source > done) {
          const windows = windowsByPair.get(item.pair) ?? {}; windows[item.timeframe] = bars; windowsByPair.set(item.pair, windows);
          const versions = versionsByPair.get(item.pair) ?? {}; versions[item.timeframe] = source; versionsByPair.set(item.pair, versions);
          pending.add(item.pair);
        }
      } catch (error) { unavailable.push({ pair: item.pair, timeframe: item.timeframe, reason: errorMessage(error) }); }
    }
    for (const pair of allowed) for (const tf of SHORT_TIMEFRAMES) if (!seen.has(`${pair}:${tf}`))
      unavailable.push({ pair, timeframe: tf, reason: 'No saved Deriv candles in D1' });
    console.info('[short-analysis-pending]', { count: pending.size, dryRun, source: 'd1' });
    async function analyse(pair: string): Promise<Outcome> {
      try {
        const windows = windowsByPair.get(pair) ?? {};
        if (!Object.keys(windows).length) return { pair, ok: true, skipped: true, timeframes: [] };
        const snapshot = snapshotByPair.get(pair);
        const analysis = await computeShortTimeframeSnapshot(pair, windows, higherIndicators(snapshot?.multi_tf), contextByPair.get(pair) ?? {});
        if (dryRun) return { pair, ok: true, skipped: false, timeframes: Object.keys(windows) };
        const { data: published, error: writeError } = await db.rpc('publish_short_timeframe_analysis', {
          p_pair: pair, p_sources: versionsByPair.get(pair) ?? {}, p_analysis: analysis,
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
  } catch (error) { outcomes.push({ pair: 'short_timeframes', ok: false, error: errorMessage(error) }); }
  return { total: outcomes.length, succeeded: outcomes.filter(row => row.ok).length,
    failed: outcomes.filter(row => !row.ok), results: outcomes, unavailable };
}