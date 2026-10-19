import { NextRequest, NextResponse } from "next/server";
import { runAnalysisBatch } from "@/services/analysisService";
import { TIER_CONFIG, type Tier } from "@/services/snapshotConfig";
import { isForexMarketClosed } from "@/lib/marketHours";
export const maxDuration = 60;
// Keep the analysis worker close to the Supabase project in Ireland.
export const preferredRegion = 'dub1';
export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") || req.nextUrl.searchParams.get("secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const tier = req.nextUrl.searchParams.get("tier") as Tier;
  if (!Object.hasOwn(TIER_CONFIG, tier)) return NextResponse.json({ error: "Invalid tier" }, { status: 400 });
  const mode = process.env.ANALYSIS_MODE || "shadow";
  if (!["active", "shadow"].includes(mode)) return NextResponse.json({ error: "ANALYSIS_MODE must be shadow or active" }, { status: 503 });
  if (isForexMarketClosed() && req.nextUrl.searchParams.get("force") !== "1")
    return NextResponse.json({ ok: true, skipped: true, reason: "Weekend" });
  const dryRun = mode !== "active" || req.nextUrl.searchParams.get("dryRun") === "1";
  const result = await runAnalysisBatch(tier, dryRun);
  return NextResponse.json({ ok: result.failed.length === 0, ...result }, { status: result.failed.length ? 503 : 200 });
}
