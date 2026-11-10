import type { AnalysisInput } from "./analysisInputs";
import type { Candle } from "./candleTypes";

type D1ApiError = { error?: string; detail?: string };
type D1InputResponse = {
  pair: string;
  tier: string | null;
  candles: Record<string, Candle[]> | null;
  fetchedAt: string | null;
};
export type D1CandleResponse = {
  pair: string;
  timeframe: string;
  candles: Candle[];
  fetchedAt: string | null;
  sourceCandleAt: string | null;
  candleCount: number;
};

function d1Config() {
  const base = process.env.D1_API_URL?.replace(/\/$/, "");
  const secret = process.env.D1_API_SECRET;
  if (!base || !secret) {
    throw new Error("D1_API_URL and D1_API_SECRET must be configured on forex-analysers");
  }
  return { base, secret };
}

async function d1Get<T>(path: string): Promise<T> {
  const { base, secret } = d1Config();
  const response = await fetch(base + path, {
    method: "GET",
    headers: {
      authorization: `Bearer ${secret}`,
      "cache-control": "no-store",
      accept: "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
    redirect: "error",
  });
  const body = await response.json().catch(() => null) as T | D1ApiError | null;
  if (!response.ok) {
    const detail = body && typeof body === "object"
      ? ("detail" in body ? body.detail : "error" in body ? body.error : "")
      : "";
    throw new Error(`D1 API ${path} failed: HTTP ${response.status}${detail ? ` — ${String(detail).slice(0, 240)}` : ""}`);
  }
  if (!body) throw new Error(`D1 API ${path} returned an empty response`);
  return body as T;
}

export async function getD1AnalysisInput(pair: string): Promise<AnalysisInput | null> {
  const result = await d1Get<D1InputResponse>(
    `/internal/v1/analysis-inputs?pair=${encodeURIComponent(pair)}`
  );
  if (!result.fetchedAt || !result.tier || !result.candles) return null;
  return {
    pair: result.pair,
    tier: result.tier,
    candles: result.candles,
    fetched_at: result.fetchedAt,
  };
}

export async function getD1CandleBundle(pair: string, timeframe: "1m" | "5m"): Promise<D1CandleResponse> {
  return d1Get<D1CandleResponse>(
    `/internal/v1/candles?pair=${encodeURIComponent(pair)}&timeframe=${timeframe}`
  );
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await task(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker));
  return results;
}
