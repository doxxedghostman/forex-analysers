# forex-analysers

Forexverse's saved-candle analysis worker, separated from `doxxedghostman/forex-cron`.
The main app keeps reading the same Supabase `market_snapshots` and `market_sentiment` tables.

## Responsibilities

- Read `market_analysis_inputs`: one atomic input bundle per instrument, published by forex-cron.
- Preserve the exact fetched analysis windows: up to 250 candles for 15m/1h/4h, up to 400 for 1d.
- Calculate indicators, SMC, chart patterns, multi-timeframe setups and weekly trend.
- Publish analysis through a version-checked database function. Never overwrite live prices, price-source timestamps or alert state.
- Calculate market sentiment using snapshot breadth, Yahoo DXY/VIX and cached CFTC positioning.

Pair analysis never downloads candles, calls DeepSeek, or sends notifications. Missing, malformed or stale inputs leave the previous successful snapshot untouched. A missing timeframe cannot trigger a Yahoo fallback. Snapshot formulas are unchanged; this move does not fix or retune the strategy.

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
