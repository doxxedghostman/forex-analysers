import { getSupabaseAdmin } from "../lib/supabaseAdmin";
import { computeSnapshot } from "./analysisEngine";
import { validateAnalysisInput, type AnalysisInput } from "./analysisInputs";
import { TIER_CONFIG, type Tier } from "./snapshotConfig";
export async function analysePair(pair: string, tier: Tier, dryRun = true) {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase.from("market_analysis_inputs")
      .select("pair,tier,candles,fetched_at").eq("pair", pair).maybeSingle();
    if (error) throw error;
    const input = data as AnalysisInput | null;
    const windows = validateAnalysisInput(input, pair, tier);
    const { data: previous, error: previousError } = await supabase.from("market_snapshots")
      .select("analysis_input_at").eq("pair", pair).maybeSingle();
    if (previousError) throw previousError;
    if (previous?.analysis_input_at && Date.parse(previous.analysis_input_at) >= Date.parse(input!.fetched_at))
      return { pair, ok: true, skipped: true, reason: "Input already analysed" };
    const start = process.cpuUsage(); const wall = performance.now();
    const snapshot = await computeSnapshot(pair, tier, windows);
    const cpu = process.cpuUsage(start);
    console.info("[analysis-cpu]", { pair, processCpuMs: (cpu.user + cpu.system) / 1000, wallMs: Math.round(performance.now() - wall) });
    // Quotes and price timestamps belong to the price worker. The RPC updates
    // only analysis fields and rejects superseded/already-published input versions.
    const { live_price, updated_at, ...analysis } = snapshot;
    if (dryRun) return { pair, ok: true, dryRun: true, inputAt: input!.fetched_at,
      direction: analysis.direction, confidence: analysis.confidence_score };
    const { data: published, error: publishError } = await supabase.rpc("publish_market_analysis", {
      p_pair: pair, p_input_at: input!.fetched_at, p_analysis: analysis,
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
    db.from('market_analysis_inputs').select('pair,tier,fetched_at'),
    db.from('market_snapshots').select('pair,analysis_input_at'),
  ]);
  if (inputs.error) throw new Error(`Could not read pending analysis inputs: ${inputs.error.message}`);
  if (snapshots.error) throw new Error(`Could not read analysed input versions: ${snapshots.error.message}`);
  const completed = new Map((snapshots.data ?? []).map(row =>
    [String(row.pair), row.analysis_input_at ? Date.parse(row.analysis_input_at) : 0]
  ));
  const pending = (inputs.data ?? []).filter(row => {
    const planned = row.tier as Tier;
    if (!Object.hasOwn(TIER_CONFIG, planned) || planned === excludedTier) return false;
    const fetchedAt = Date.parse(row.fetched_at);
    const allowedAgeMs = TIER_CONFIG[planned].refreshMinutes * 2.5 * 60_000;
    return Number.isFinite(fetchedAt) && fetchedAt <= now + 60_000
      && now - fetchedAt <= allowedAgeMs
      && fetchedAt > (completed.get(String(row.pair)) ?? 0);
  }).sort((a, b) => Date.parse(a.fetched_at) - Date.parse(b.fetched_at));
  const recovered = [];
  for (const input of pending.slice(0, Math.max(0, Math.min(2, maxPairs)))) {
    const outcome = await analysePair(input.pair, input.tier as Tier, false);
    recovered.push(outcome);
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
  return { tier, dryRun, total: results.length, succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok), results, recovery };
}
