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
export async function runAnalysisBatch(tier: Tier, dryRun = true) {
  const results = [];
  for (const pair of TIER_CONFIG[tier].pairs) results.push(await analysePair(pair, tier, dryRun));
  return { tier, dryRun, total: results.length, succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok), results };
}
