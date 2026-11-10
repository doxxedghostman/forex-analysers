const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loader, root } = require('./helpers.cjs');

const load = loader();
const { getD1AnalysisInput, getD1AnalysisInputMetadata, getD1CandleBundle } = load(path.join(root, 'src/services/d1MarketData.ts'));

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('D1 analysis input uses the authenticated Account A API and maps the fetch version', async () => {
  const previousFetch = global.fetch;
  const previousUrl = process.env.D1_API_URL;
  const previousSecret = process.env.D1_API_SECRET;
  process.env.D1_API_URL = 'https://collector-a.example.workers.dev/';
  process.env.D1_API_SECRET = 'test-secret';
  let requested;
  global.fetch = async (url, init) => { requested = { url, init }; return response({
    pair: 'EURUSD', tier: 'core', fetchedAt: '2026-11-10T12:00:00.000Z',
    candles: { '15m': [], '1h': [], '4h': [], '1d': [] },
  }); };
  try {
    const input = await getD1AnalysisInput('EURUSD');
    assert.equal(input.pair, 'EURUSD');
    assert.equal(input.fetched_at, '2026-11-10T12:00:00.000Z');
    assert.equal(requested.url, 'https://collector-a.example.workers.dev/internal/v1/analysis-inputs?pair=EURUSD');
    assert.equal(requested.init.headers.authorization, 'Bearer test-secret');
    assert.equal(requested.init.cache, 'no-store');
  } finally {
    global.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.D1_API_URL; else process.env.D1_API_URL = previousUrl;
    if (previousSecret === undefined) delete process.env.D1_API_SECRET; else process.env.D1_API_SECRET = previousSecret;
  }
});

test('D1 metadata index and bounded short candle endpoint are requested', async () => {
  const previousFetch = global.fetch;
  const previousUrl = process.env.D1_API_URL;
  const previousSecret = process.env.D1_API_SECRET;
  process.env.D1_API_URL = 'https://collector-a.example.workers.dev';
  process.env.D1_API_SECRET = 'test-secret';
  const urls = [];
  global.fetch = async url => {
    urls.push(String(url));
    if (String(url).endsWith('/internal/v1/analysis-inputs')) return response({ inputs: [{ pair: 'EURUSD', tier: 'core', fetched_at: '2026-11-10T12:00:00Z' }] });
    return response({ pair: 'EURUSD', timeframe: '1m', candles: [], fetchedAt: null, sourceCandleAt: null, candleCount: 0 });
  };
  try {
    const metadata = await getD1AnalysisInputMetadata();
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].pair, 'EURUSD');
    await getD1CandleBundle('EURUSD', '1m');
    assert.ok(urls.includes('https://collector-a.example.workers.dev/internal/v1/analysis-inputs'));
    assert.ok(urls.includes('https://collector-a.example.workers.dev/internal/v1/candles?pair=EURUSD&timeframe=1m&limit=250'));
  } finally {
    global.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.D1_API_URL; else process.env.D1_API_URL = previousUrl;
    if (previousSecret === undefined) delete process.env.D1_API_SECRET; else process.env.D1_API_SECRET = previousSecret;
  }
});

test('D1 client fails closed when credentials are missing or the API rejects a request', async () => {
  const previousFetch = global.fetch;
  const previousUrl = process.env.D1_API_URL;
  const previousSecret = process.env.D1_API_SECRET;
  delete process.env.D1_API_URL;
  delete process.env.D1_API_SECRET;
  try {
    await assert.rejects(() => getD1AnalysisInput('EURUSD'), /D1_API_URL and D1_API_SECRET/);
    process.env.D1_API_URL = 'https://collector-a.example.workers.dev';
    process.env.D1_API_SECRET = 'test-secret';
    global.fetch = async () => response({ error: 'Unauthorized' }, 401);
    await assert.rejects(() => getD1AnalysisInput('EURUSD'), /HTTP 401/);
  } finally {
    global.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.D1_API_URL; else process.env.D1_API_URL = previousUrl;
    if (previousSecret === undefined) delete process.env.D1_API_SECRET; else process.env.D1_API_SECRET = previousSecret;
  }
});