import { NextRequest, NextResponse } from "next/server";
import { refreshMarketSentiment } from "@/services/marketSentimentService";
export const maxDuration = 60;
export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") || req.nextUrl.searchParams.get("secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const mode = process.env.ANALYSIS_MODE || "shadow";
  if (!["active", "shadow"].includes(mode)) return NextResponse.json({ error: "Invalid ANALYSIS_MODE" }, { status: 503 });
  try {
    const dryRun = mode !== "active" || req.nextUrl.searchParams.get("dryRun") === "1";
    return NextResponse.json({ ok: true, ...await refreshMarketSentiment(dryRun) });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500 });
  }
}
