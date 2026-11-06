# forex-analysers

Forexverse's saved-candle analysis worker, separated from `doxxedghostman/forex-cron`.
The main app keeps reading the same Supabase `market_snapshots` and `market_sentiment` tables.

## Responsibilities

- Read `market_analysis_inputs`: one atomic input bundle per instrument, published by forex-cron.
- Preserve the exact fetched analysis windows: up to 250 candles for 15m/1h/4h, up to 400 for 1d.
- Calculate indicators, SMC, chart patterns, multi-timeframe setups and weekly trend.
- Publish analysis through a version-checked database function. Never overwrite live prices, price-source timestamps or alert state.
- Calculate market sentiment using snapshot breadth, Yahoo DXY/VIX and cached CFTC positioning.

Pair analysis never downloads candles, calls DeepSeek, or sends notifications. Missing, materially malformed or stale inputs leave the previous successful snapshot untouched. Only daily spot-FX candles with very small Yahoo high/low boundary inconsistencies (at most 0.1% of price AND 15% of reported bar range) are normalized in a non-mutating, analysis-only copy. Other timeframes and metals remain strictly validated. The original raw Yahoo inputs and cached history are never rewritten, and rejected inputs still cannot publish. The analysis-only correction can slightly change daily indicators. The analyser logs `[analysis-daily-ohlc-normalized]` when it repairs an input. A missing timeframe cannot trigger a Yahoo fallback. Snapshot formulas are unchanged; this move does not fix or retune the strategy.

The collector owns the deep chart caches, current prices and alerts. The handoff table preserves the raw analysis windows rather than replacing them with deeper/repaired chart history, which could change indicator results. The input timestamp is a fetch version, not a candle-close timestamp. Source age is checked separately during open market hours.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Same project as forex-cron/main app |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-only database key; never NEXT_PUBLIC |
| `CRON_SECRET` | Yes | Generate a distinct secret for this worker |
| `ANALYSIS_MODE` | No | `shadow` (default) computes without writes; `active` publishes |

No DeepSeek or Firebase environment variables are needed. No API key is used for the public DXY/VIX/CFTC sources.

## Routes

Authenticate cron calls with the `x-cron-secret` header. The existing `secret` query parameter is supported for scheduler compatibility, but headers avoid putting the secret in URLs.

- `GET /api/health`: non-secret service/mode check; does not check database connectivity.
- `GET /api/cron/analyse?tier=core`
- `GET /api/cron/analyse?tier=extended_a` (or `extended_b`, `extended_c`)
- `GET /api/cron/market-sentiment`

`dryRun=1` always prevents writes, including in active mode. `force=1` bypasses only the authenticated analysis route's weekend guard; it does not bypass input freshness or enable writes in shadow mode. On weekends, force a collector snapshot first so its handoff fetch timestamp is fresh. Do not use force on ordinary schedules. Sentiment retains its existing continuous schedule.

Responses include per-pair outcomes. Partial/total failures return 503 so they are visible to the scheduler. Already analysed or superseded input versions are successful no-ops. Inspect JSON `published`, `skipped` and `dryRun`; HTTP 200 alone does not prove a database write.

## Database preparation

`database/analysis-handoff.sql` is the schema reference for Supabase migration `separate_market_data_and_analysis_handoff`. It adds the handoff table, `market_snapshots.analysis_input_at`, and two service-role-only functions. The table has RLS with no client policies intentionally: only server workers access it. Functions use invoker security. No existing cache rows are replaced.

- `publish_market_analysis_input`: only accepts a newer fetch version.
- `publish_market_analysis`: locks/checks that input version and updates only analysis fields. Repeated/older analyses cannot overwrite newer results or fresh prices.

This schema was applied and transactionally verified during the repository split. Do not apply it to a different project without checking the target.

## Deployment and safe cutover

**Use the existing collector cron-job.org jobs. Do not create nine analyser jobs.** The collector now calls this worker automatically after each successful data batch and forwards its existing sentiment job here. Normal collector URLs using `?secret=...` keep working without Advanced headers.

- On this analyser: use the existing shared Supabase variables, its own `CRON_SECRET`, and initially `ANALYSIS_MODE=shadow`.
- On forex-cron: copy this analyser's CRON_SECRET into `ANALYSER_CRON_SECRET`. Keep its original collector CRON_SECRET unchanged.
- For a controlled cutover, pause snapshot/sentiment timers, wait for in-flight legacy requests (maximum 60 seconds), and deploy collector `SNAPSHOT_MODE=data`. The two-minute price/alert timer stays running.
- Manually test an existing collector snapshot URL. During weekends add authenticated `force=1` to that one URL. The collector saves candle inputs first, then calls this worker and includes its result. Shadow results must have `dryRun:true`; HTTP 200 alone is not proof of publication.
- After verification, deploy this analyser with `ANALYSIS_MODE=active` and resume the same collector timers. Confirm published input versions and database timestamps. No new cron-job.org URLs or analyser timers are necessary.

The existing five-minute core job also rotates the new cross batches: D in one five-minute slot, E in the next, F+G in the next, then repeats. Thus all new crosses run every 15 minutes with no extra timers. Core/A/B/C cadence remains unchanged. Logical batch IDs stay core + A-G; they do not imply eight external analyser timers. Do not also schedule D-G manually, or run standalone analyser/sentiment timers, when using the automatic flow. Direct authenticated endpoints remain available for manual diagnostics.

The configured list is 18 currency pairs plus 5 metals. Market sentiment intentionally retains the original 13-instrument breadth weights instead of assigning arbitrary risk-on weights to new crosses. All pair-analysis inputs are from the collector's Yahoo source; no DeepSeek/Firebase variables or external candle requests are added here. The main app keeps reading the same snapshots and sentiment.

## Rollback

Pause collector snapshot/sentiment timers and allow requests to finish, redeploy this analyser with `ANALYSIS_MODE=shadow`, redeploy forex-cron with `SNAPSHOT_MODE=legacy`, and resume the same existing jobs. Keep additive handoff schema. The collector retains dormant legacy analysis for this purpose.

## Validation

`npm ci`, `npm test`, `npm run build`.
Tests compare the analysis engine to the frozen old implementation, reject malformed/stale input, preserve quote ownership, check version publication and verify all ten new crosses without external candle requests. `[analysis-cpu]` is process-wide diagnostic timing, not exact per-request billing. Source mappings are direct Yahoo PAIR=X; four-hour bars remain resampled from Yahoo hourly bars. Live development probes hit HTTP 429, so deployed collector logs are still needed to verify real provider timestamps and history completeness. Native charts retain the existing daily-FX repair behavior; separately labelled TradingView reference widgets are not the native data source.

# Deriv 1m and 5m analysis

Apply `supabase/migrations/20261106020115_short_timeframe_analysis.sql` before
deploying this version. Existing environment variables remain unchanged.
The existing five-minute `GET /api/cron/analyse?all=1` schedule now also analyses
fresh, closed 1m/5m candles saved by the Deriv listener, independently of longer
input versions. No new cron jobs or Yahoo requests are added.

Each short frame gets indicators (including EMA200), structure, chart patterns
and its own deterministic setup in `market_snapshots.multi_tf`,
`structure_by_tf`, `patterns_by_tf` and `setups`. Short results carry their Deriv
source timestamp and analysis timestamp. An independent source-version marker
prevents duplicate work and older results replacing newer results. Longer-frame
publishes preserve the short entries; short publishes do not change the 4H
recommendation, live quote, longer-frame timestamps or weekly trend.

Only the latest 250 saved bars are read per available frame. Require at least
200 valid, ordered closed bars; stale or unsupported frames are reported in
`shortTimeframes.unavailable` without blocking other frames. Deriv currently
covers 20 instruments; CADJPY, CHFJPY and CPPER have no saved Deriv short bars.
Cached recent higher-frame indicator context is passed into short setups when
available, without downloading the complete longer candle histories again.

Logs: `[short-analysis-pending]`, `[short-analysis-published]`,
`[short-analysis-failed]`. Shadow mode computes without publishing. The route's
`shortTimeframes` result lists publications, skipped work and unavailable data.


## Calculation resource optimisation

ADX rolling sums are computed once per series using the original arithmetic.
Closed-candle structure/liquidity results are shared between patterns, the 4H
summary and setup generation. A 160-entry in-memory LRU cache reuses indicators,
structure and patterns only when the complete timestamp/OHLCV window matches.
Historical corrections invalidate it. Results are copied so callers cannot mutate
cached values. Cache reuse is best-effort per warm process; a cold process always
calculates normally. It stores no cross-request prediction, clock-dependent
killzone state or publication markers. All timeframe setups still rebuild with
current multi-timeframe context.

Short analysis publishes only frames newer than their own publication markers;
an unchanged available short frame remains alignment context for its sibling.
The all-pending batch shares already-loaded publication markers with pair jobs
and the short pass, removing up to 24 metadata requests for a fully pending
23-instrument batch. Postgres remains the final authority for concurrent versions.
Freshness checks run before an already-analysed input can be skipped.

No database migration, environment variable or cron change is needed.
Validation: 47 tests pass and the production build succeeds. Full before/after
long and short outputs matched for EURUSD, USDJPY, XAUUSD and PLTUM, excluding
only the generated longer-snapshot timestamp. Seven-sample local median CPU
benchmarks per instrument (not Vercel billing) were:

| Work | Original | Optimised, changing windows | Optimised, identical windows |
| --- | ---: | ---: | ---: |
| Four longer frames | 170.7 ms | 20.1 ms | 4.6 ms |
| Both short frames | 59.4 ms | 7.9 ms | 2.0 ms |
