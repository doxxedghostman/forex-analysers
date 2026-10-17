import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

type SentimentLabel = 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed';

type ComponentStatus = 'fresh' | 'cached' | 'unavailable';

interface ComponentReading {
  score: number | null;
  status: ComponentStatus;
  value?: number | null;
  change5d?: number | null;
  reportDate?: string | null;
  detail?: string;
  fetchedAt?: string | null;
}

interface StoredSentiment {
  components?: Record<string, ComponentReading>;
  cot_fetched_at?: string | null;
}

const DXY_SYMBOL = 'DX-Y.NYB';
const VIX_SYMBOL = '^VIX';
const CFTC_TFF_URL = 'https://www.cftc.gov/dea/newcot/FinFutWk.txt';
const COT_CACHE_MS = 6 * 60 * 60 * 1000;

const COMPONENT_WEIGHTS = {
  breadth: 0.50,
  vix: 0.20,
  dxy: 0.15,
  cot: 0.15,
} as const;

// +1 means a Long signal is treated as risk-on; -1 means a Long signal is
// treated as risk-off for this broad market-mood index.
const RISK_ORIENTATION: Record<string, number> = {
  EURUSD: 1,
  GBPUSD: 1,
  AUDUSD: 1,
  NZDUSD: 1,
  GBPJPY: 1,
  USDJPY: 1,
  USDCHF: 1,
  USDCAD: -1,
  XAUUSD: -1,
  XAGUSD: 0.5,
  CPPER: 1,
  PLTUM: 0.75,
  PALDM: 0.75,
};

const COT_MARKETS: Array<{ prefix: string; orientation: number }> = [
  { prefix: 'EURO FX -', orientation: 1 },
  { prefix: 'BRITISH POUND -', orientation: 1 },
  { prefix: 'AUSTRALIAN DOLLAR -', orientation: 1 },
  { prefix: 'NZ DOLLAR -', orientation: 1 },
  { prefix: 'CANADIAN DOLLAR -', orientation: 1 },
  { prefix: 'JAPANESE YEN -', orientation: -1 },
  { prefix: 'SWISS FRANC -', orientation: -1 },
];

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function labelFor(score: number): SentimentLabel {
  if (score <= 20) return 'Extreme Fear';
  if (score <= 40) return 'Fear';
  if (score < 60) return 'Neutral';
  if (score < 80) return 'Greed';
  return 'Extreme Greed';
}

async function fetchYahooDaily(symbol: string) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Forexverse/1.0)' },
  });
  if (!response.ok) throw new Error(`Yahoo ${symbol} failed: ${response.status}`);

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error(`Yahoo ${symbol} returned non-JSON data`);

  const data: any = await response.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${symbol} returned no chart data`);

  const closes = (result.indicators?.quote?.[0]?.close || [])
    .map((v: unknown) => Number(v))
    .filter((v: number) => Number.isFinite(v) && v > 0);

  const price = Number(result.meta?.regularMarketPrice);
  const timestamp = Number(result.meta?.regularMarketTime);
  const latest = Number.isFinite(price) && price > 0 ? price : closes.at(-1);
  if (!Number.isFinite(latest) || latest <= 0 || closes.length < 6) {
    throw new Error(`Yahoo ${symbol} has insufficient daily data`);
  }

  const previous = closes.at(-6)!;
  const change5d = ((latest - previous) / previous) * 100;
  return {
    price: latest,
    change5d,
    sourceAt: Number.isFinite(timestamp) && timestamp > 0
      ? new Date(timestamp * 1000).toISOString()
      : new Date().toISOString(),
  };
}

async function readDxy(): Promise<ComponentReading> {
  const q = await fetchYahooDaily(DXY_SYMBOL);
  // A strengthening USD often accompanies tighter / more defensive conditions.
  // A 5-day move of +/-4% maps near the ends of the 0-100 risk scale.
  const score = clamp(50 - clamp(q.change5d, -4, 4) * 10);
  return {
    score: Math.round(score),
    status: 'fresh',
    value: round1(q.price),
    change5d: round1(q.change5d),
    detail: q.change5d > 0.15 ? 'USD strengthening' : q.change5d < -0.15 ? 'USD weakening' : 'USD broadly steady',
    fetchedAt: q.sourceAt,
  };
}

function vixScore(value: number) {
  if (value <= 12) return 90;
  if (value <= 15) return 90 - ((value - 12) / 3) * 10;
  if (value <= 20) return 80 - ((value - 15) / 5) * 25;
  if (value <= 25) return 55 - ((value - 20) / 5) * 20;
  if (value <= 35) return 35 - ((value - 25) / 10) * 25;
  return Math.max(0, 10 - (value - 35));
}

async function readVix(): Promise<ComponentReading> {
  const q = await fetchYahooDaily(VIX_SYMBOL);
  const score = clamp(vixScore(q.price));
  return {
    score: Math.round(score),
    status: 'fresh',
    value: round1(q.price),
    change5d: round1(q.change5d),
    detail: q.price >= 25 ? 'Volatility elevated' : q.price <= 15 ? 'Volatility calm' : 'Volatility moderate',
    fetchedAt: q.sourceAt,
  };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out;
}

async function fetchCot(): Promise<ComponentReading> {
  const response = await fetch(CFTC_TFF_URL, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': 'Forexverse market sentiment service' },
  });
  if (!response.ok) throw new Error(`CFTC COT failed: ${response.status}`);
  const text = await response.text();

  const rows = text.split(/\r?\n/).filter(Boolean).map(parseCsvLine);
  const votes: number[] = [];
  let reportDate: string | null = null;

  for (const market of COT_MARKETS) {
    const row = rows.find((r) => (r[0] || '').toUpperCase().startsWith(market.prefix));
    if (!row) continue;

    // TFF Futures Only layout:
    // 7=open interest, 14=leveraged-money long, 15=leveraged-money short.
    const openInterest = Number(row[7]);
    const long = Number(row[14]);
    const short = Number(row[15]);
    if (![openInterest, long, short].every(Number.isFinite) || openInterest <= 0) continue;

    const netRatio = (long - short) / openInterest;
    // Roughly +/-35% of open interest is already an extreme leveraged-money
    // skew for this cross-market breadth input.
    const normalized = clamp((netRatio * market.orientation) / 0.35, -1, 1);
    votes.push(normalized);
    reportDate ||= row[2] || null;
  }

  if (votes.length < 4) throw new Error('CFTC COT returned too few tracked FX markets');

  const avg = votes.reduce((a, b) => a + b, 0) / votes.length;
  const score = clamp(50 + avg * 50);
  return {
    score: Math.round(score),
    status: 'fresh',
    reportDate,
    detail: score >= 60 ? 'Leveraged positioning leans risk-on' : score <= 40 ? 'Leveraged positioning leans defensive' : 'Leveraged positioning is mixed',
    fetchedAt: new Date().toISOString(),
  };
}

async function readInternalBreadth(): Promise<ComponentReading> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('market_snapshots')
    .select('pair,direction,confidence_score,updated_at');

  if (error) throw error;

  let weighted = 0;
  let totalWeight = 0;
  let latestAt: string | null = null;

  for (const row of data ?? []) {
    const orientation = RISK_ORIENTATION[row.pair];
    if (!orientation) continue;

    const rawDirection = row.direction === 'Long' ? 1 : row.direction === 'Short' ? -1 : 0;
    const confidence = clamp(Number(row.confidence_score) || 50, 20, 100) / 100;
    const instrumentWeight = Math.abs(orientation);
    const weight = confidence * instrumentWeight;

    weighted += rawDirection * Math.sign(orientation) * weight;
    totalWeight += weight;

    if (row.updated_at && (!latestAt || row.updated_at > latestAt)) latestAt = row.updated_at;
  }

  if (totalWeight <= 0) throw new Error('No usable market snapshot breadth data');

  const avg = clamp(weighted / totalWeight, -1, 1);
  const score = clamp(50 + avg * 50);
  return {
    score: Math.round(score),
    status: 'fresh',
    detail: score >= 60 ? 'Forexverse breadth leans risk-on' : score <= 40 ? 'Forexverse breadth leans defensive' : 'Forexverse breadth is mixed',
    fetchedAt: latestAt,
  };
}

function componentOrUnavailable(result: PromiseSettledResult<ComponentReading>): ComponentReading {
  return result.status === 'fulfilled'
    ? result.value
    : { score: null, status: 'unavailable', detail: String(result.reason?.message || result.reason || 'Unavailable') };
}

function buildDrivers(components: Record<string, ComponentReading>) {
  return Object.entries(components)
    .filter(([, c]) => c.score != null)
    .sort((a, b) => Math.abs((b[1].score ?? 50) - 50) - Math.abs((a[1].score ?? 50) - 50))
    .slice(0, 3)
    .map(([name, c]) => ({
      source: name,
      score: c.score,
      text: c.detail || '',
    }));
}

export async function refreshMarketSentiment(dryRun = false) {
  const supabase = getSupabaseAdmin();

  const { data: previous } = await supabase
    .from('market_sentiment')
    .select('components,cot_fetched_at')
    .eq('id', 'global')
    .maybeSingle<StoredSentiment>();

  const cotAge = previous?.cot_fetched_at ? Date.now() - new Date(previous.cot_fetched_at).getTime() : Infinity;
  const cachedCot = previous?.components?.cot;
  const shouldRefreshCot = !cachedCot || cachedCot.score == null || cotAge >= COT_CACHE_MS;

  const [breadthResult, dxyResult, vixResult, cotResult] = await Promise.allSettled([
    readInternalBreadth(),
    readDxy(),
    readVix(),
    shouldRefreshCot ? fetchCot() : Promise.resolve({ ...cachedCot!, status: 'cached' as const }),
  ]);

  const components: Record<string, ComponentReading> = {
    breadth: componentOrUnavailable(breadthResult),
    dxy: componentOrUnavailable(dxyResult),
    vix: componentOrUnavailable(vixResult),
    cot: componentOrUnavailable(cotResult),
  };

  // If a fresh COT call fails, retain the last known weekly report instead of
  // throwing away a still-useful slow-moving positioning input.
  if (components.cot.score == null && cachedCot?.score != null) {
    components.cot = { ...cachedCot, status: 'cached' };
  }

  let weightedScore = 0;
  let availableWeight = 0;
  for (const [name, weight] of Object.entries(COMPONENT_WEIGHTS)) {
    const score = components[name]?.score;
    if (score == null || !Number.isFinite(score)) continue;
    weightedScore += score * weight;
    availableWeight += weight;
  }
  if (availableWeight < 0.5) throw new Error('Not enough sentiment inputs are available');

  const score = Math.round(clamp(weightedScore / availableWeight));
  const label = labelFor(score);
  const now = new Date().toISOString();
  const drivers = buildDrivers(components);

  const dxyAt = components.dxy.fetchedAt || null;
  const vixAt = components.vix.fetchedAt || null;
  const cotReportAt = components.cot.reportDate || previous?.components?.cot?.reportDate || null;
  const cotFetchedAt = shouldRefreshCot && cotResult.status === 'fulfilled'
    ? now
    : previous?.cot_fetched_at || components.cot.fetchedAt || null;

  if (!dryRun) {
  const { error } = await supabase.from('market_sentiment').upsert({
    id: 'global',
    score,
    label,
    components,
    drivers,
    dxy_updated_at: dxyAt,
    vix_updated_at: vixAt,
    cot_report_at: cotReportAt,
    cot_fetched_at: cotFetchedAt,
    updated_at: now,
  }, { onConflict: 'id' });

  if (error) throw error;
  }

  return {
    dryRun,
    score,
    label,
    components,
    drivers,
    updatedAt: now,
    cotRefreshed: shouldRefreshCot && cotResult.status === 'fulfilled',
  };
}

