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

1. Deploy forex-cron with `SNAPSHOT_MODE=legacy` and `PUBLISH_ANALYSIS_INPUTS=true`. Its existing schedules and analysis still work while it fills handoff inputs.
2. Import this private repository into the analysis Vercel account. Select Next.js, Node 22.x or newer supported Node runtime, and set the four variables above with `ANALYSIS_MODE=shadow`. Ensure the Vercel GitHub integration has access to this private repo. Shadow is the code default.
3. Run every tier once in shadow mode after the collector has refreshed it. During weekends use authenticated `force=1` on both workers, collector first. Verify four timeframes, expected pairs, successful outcomes and `dryRun:true`. Verify sentiment with `dryRun=1` too.
4. Pause collector snapshot and sentiment schedules briefly; keep the two-minute price job running. Wait for in-flight legacy snapshots to finish (maximum route duration 60 seconds).
5. Redeploy forex-cron with `SNAPSHOT_MODE=data`. It now fetches/saves only; the old sentiment URL becomes a no-op. Keep the existing collector snapshot URLs and frequencies.
6. Redeploy this worker with `ANALYSIS_MODE=active`. Resume collector schedules. Add analyser schedules below and move the sentiment schedule here. Confirm `published:true` and snapshot timestamps in the shared database before declaring cutover complete.

Start analyser batches about 1-2 minutes after their corresponding collector batches. Example if collectors are on exact 5/15-minute boundaries:

| Job | Frequency | Example analyser cron |
| --- | --- | --- |
| core | 5 minutes | `2-59/5 * * * *` |
| extended_a/b/c | 15 minutes each | `2,17,32,47 * * * *` |
| market-sentiment | 5 minutes | `3-59/5 * * * *` |

If the existing jobs are staggered differently, offset each analyser from its actual collector timer. Freshness/version checks protect against delays, not a guaranteed execution order. Supabase and provider failures can still cause missed updates. Use cron-job.org (the existing scheduler); Vercel native cron on Hobby is not suitable for these intervals.

The current list remains 13 instruments. Add new pairs to both workers' instrument and tier configuration only after data-source verification; neither repo silently expands the list during this migration. Sentiment currently weights only those original 13 instruments and needs a deliberate weighting decision for new crosses.

## Rollback

Pause analyser/sentiment schedules, allow in-flight analyser requests to finish, redeploy with `ANALYSIS_MODE=shadow`, then redeploy forex-cron with `SNAPSHOT_MODE=legacy` and resume its original snapshot/sentiment schedules. Leave the additive schema in place. The legacy code remains in forex-cron for this rollback; data-only mode never imports it. Do not run both writers actively during cutover.

## Validation

`npm ci`, `npm test`, `npm run build`.
Tests compare the new analysis output against the original snapshot implementation on deterministic forex and metals inputs, reject bad/stale inputs, check shadow/auth controls and ensure prices are excluded from analysis writes. `tests/fixtures` contains the frozen pre-split implementation solely for regression tests; it is not deployed as a route. `[analysis-cpu]` logs report process-wide CPU deltas; concurrent invocations can contribute, so these are diagnostic measurements rather than exact per-request billing.
