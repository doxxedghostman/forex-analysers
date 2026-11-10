import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { computeSnapshot } from "./analysisEngine";
import { validateAnalysisInput, validateAnalysisInputMetadata, type AnalysisInput } from "./analysisInputs";
import { TIER_CONFIG, type Tier } from "./snapshotConfig";
import { runPendingShortAnalysis } from './shortTimeframeAnalysis';
import { getD1AnalysisInput, getD1AnalysisInputMetadata } from './d1MarketData';
export async function analysePair(pair: string, tier: Tier, dryRun = true, knownAnalysisInputAt?: string | null, knownInput?: AnalysisInput | null) {
  const supabase = getSupabaseAdmin();
  try {
    // Candle bundles are owned by Cloudflare D1. Supabase remains the output
    // store for snapshots and the atomic, version-checked publication RPC.
    const input = knownInput === undefined ? await getD1AnalysisInput(pair) : knownInput;
    validateAnalysisInputMetadata(input, pair, tier);
    let previousAt = knownAnalysisInputAt;
    if (previousAt === undefined) {
      const { data: previous, error: previousError } = await supabase.from("market_snapshots")
        .select("analysis_input_at").eq("pair", pair).maybeSingle();
      if (previousError) throw previousError;
      previousAt = previous?.analysis_input_at;
    }
    if (previousAt && input && Date.parse(previousAt) >= Date.parse(input.fetched_at))
      return { pair, ok: true, skipped: true, reason: "Input already analysed" };
    const windows = validateAnalysisInput(input, pair, tier);
    const start = process.cpuUsage(); const wall = performance.now();
    const snapshot = await computeSnapshot(pair, tier, windows);
    const cpu = process.cpuUsage(start);
    console.info("[analysis-cpu]", { pair, processCpuMs: (cpu.user + cpu.system) / 1000, wallMs: Math.round(performance.now() - wall) });
    // Quotes and price timestamps belong to the price worker. The RPC updates
    // only analysis fields and rejects superseded/already-published input versions.
    const { live_price, updated_at, ...analysis } = snapshot;
    if (dryRun) return { pair, ok: true, dryRun: true, inputAt: input!.fetched_at,
      direction: analysis.direction, confidence: analysis.confidence_score };
    const sourceCandleAt = input!.candles["15m"]?.at(-1)?.timestamp;
    if (!Number.isFinite(sourceCandleAt) || Number(sourceCandleAt) <= 0)
      throw new Error("Missing valid 15m source candle timestamp for publication");
    const { data: published, error: publishError } = await supabase.rpc("publish_market_analysis_from_d1", {
      p_pair: pair, p_input_at: input!.fetched_at, p_source_candle_epoch: sourceCandleAt, p_analysis: analysis,
    });
    if (publishError) throw publishError;
    return { pair, ok: true, published: published === true, skipped: published !== true, inputAt: input!.fetched_at };
  } catch (error: any) {
    // Keep the last successful snapshot unchanged on missing/stale inputs.
    console.error("[analysis-failed]", pair, error?.message);
    return { pair, ok: false, error: String(error?.message || error) };
  }
}
// Recover already-saved inputs from another tier without another provider
// fetch. Analysis publishing is version-checked in Postgres, so overlapping
// attempts cannot replace a newer snapshot.
export async function recoverPendingAnalysis(excludedTier: Tier, maxPairs = 2, now = Date.now()) {
  const db = getSupabaseAdmin();
  const [inputs, snapshots] = await Promise.all([
    getD1AnalysisInputMetadata(),
    db.from('market_snapshots').select('pair,analysis_input_at'),
  ]);
  if (snapshots.error) throw new Error('Could not read analysed input versions: ' + snapshots.error.message);
  const completed = new Map((snapshots.data ?? []).map(row => [String(row.pair), row.analysis_input_at ? Date.parse(row.analysis_input_at) : 0]));
  const pending = inputs.filter(row => {
    const planned = row.tier as Tier;
    if (!Object.hasOwn(TIER_CONFIG, planned) || planned === excludedTier) return false;
    const fetchedAt = Date.parse(row.fetched_at);
    const allowedAgeMs = TIER_CONFIG[planned].refreshMinutes * 2.5 * 60_000;
    return Number.isFinite(fetchedAt) && fetchedAt <= now + 60_000 && now - fetchedAt <= allowedAgeMs && fetchedAt > (completed.get(String(row.pair)) ?? 0);
  }).sort((a, b) => Date.parse(a.fetched_at) - Date.parse(b.fetched_at));
  const recovered = [];
  for (const input of pending.slice(0, Math.max(0, Math.min(2, maxPairs)))) {
    const previous = completed.get(String(input.pair));
    recovered.push(await analysePair(input.pair, input.tier as Tier, false, previous ? new Date(previous).toISOString() : null));
  }
  return recovered;
}
export async function runAnalysisBatch(tier: Tier, dryRun = true) {
  const startedAt = Date.now();
  const results = [];
  for (const pair of TIER_CONFIG[tier].pairs) results.push(await analysePair(pair, tier, dryRun));
  let recovery: Awaited<ReturnType<typeof recoverPendingAnalysis>> = [];
  // Keep recovery strictly best-effort and inside the collector's 18-second
  // acknowledgement timeout. Never make the primary tier depend on recovery.
  if (!dryRun && Date.now() - startedAt < 8_000) {
    try {
      recovery = await recoverPendingAnalysis(tier, 2);
      if (recovery.length) console.info('[analysis-recovery]', {
        tier, attempted: recovery.length,
        published: recovery.filter(result => result.ok && result.published).length,
        failed: recovery.filter(result => !result.ok).map(result => result.pair),
      });
    } catch (error: any) {
      console.warn('[analysis-recovery-failed]', { tier, error: String(error?.message || error) });
    }
  }
  const shortTimeframes = await runPendingShortAnalysis(dryRun, tier);
  return { tier, dryRun, total: results.length, succeeded: results.filter(r => r.ok).length,
    failed: [...results.filter(r => !r.ok), ...shortTimeframes.failed], results, recovery, shortTimeframes };
}

/** Independent five-minute analyser. Only pending input versions are read, and
 *  one bad instrument never blocks another. No Yahoo/collector HTTP calls. */
export async function runAllPendingAnalysis(dryRun = true) {
  const db = getSupabaseAdmin();
  const [inputs, snapshots] = await Promise.all([
    getD1AnalysisInputMetadata(),
    db.from('market_snapshots').select('pair,analysis_input_at,short_analysis_sources,multi_tf'),
  ]);
  if (snapshots.error) throw new Error('Failed to load analysed input versions: ' + snapshots.error.message);
  const completed = new Map((snapshots.data ?? []).map(row => [String(row.pair), row.analysis_input_at ? Date.parse(row.analysis_input_at) : 0]));
  const pending = inputs.filter(row => Object.hasOwn(TIER_CONFIG, row.tier) && Number.isFinite(Date.parse(row.fetched_at))
    && Date.parse(row.fetched_at) > (completed.get(String(row.pair)) ?? 0))
    .sort((a, b) => Date.parse(a.fetched_at) - Date.parse(b.fetched_at));
  console.info('[analysis-pending]', { count: pending.length, dryRun });
  const results: Awaited<ReturnType<typeof analysePair>>[] = [];
  for (let i = 0; i < pending.length; i += 3) {
    const group = await Promise.all(pending.slice(i, i + 3).map(input => {
      const previous = completed.get(String(input.pair));
      return analysePair(input.pair, input.tier as Tier, dryRun, previous ? new Date(previous).toISOString() : null);
    }));
    results.push(...group);
  }
  const shortTimeframes = await runPendingShortAnalysis(dryRun, undefined, snapshots.data ?? []);
  return { all: true, dryRun, total: pending.length, succeeded: results.filter(x => x.ok).length,
    failed: [...results.filter(x => !x.ok), ...shortTimeframes.failed], results, shortTimeframes };
}
