import { NextResponse } from "next/server";
export async function GET() {
  return NextResponse.json({ service: "forex-analysers", mode: process.env.ANALYSIS_MODE || "shadow", timeframes: ["15m", "1h", "4h", "1d"] });
}
