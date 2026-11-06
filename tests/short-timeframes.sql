-- Execute inside BEGIN/ROLLBACK, after the migration. Test data must never commit.
do $test$
declare
 p text := 'TSTUSD'; e1 bigint := floor(extract(epoch from now())/60)::bigint*60-60;
 e5 bigint := floor(extract(epoch from now())/300)::bigint*300-300;
 at_time timestamptz := now(); bundle jsonb; report jsonb; original_short jsonb;
begin
 if exists(select 1 from public.market_snapshots where pair=p) then raise exception 'Reserved test pair exists'; end if;
 insert into public.market_snapshots(pair,tier,anchor_interval,live_price,direction,multi_tf,structure_by_tf,patterns_by_tf,setups,analysis_input_at)
 values(p,'core','4h',123,'Short','{"4h":{"keep":true}}','{"4h":{"keep":true}}','{"4h":{"keep":true}}','{"4h":{"keep":true}}',at_time-interval '1 hour');
 insert into public.deriv_candles(symbol,timeframe,epoch,open,high,low,close)
 values(p,'1m',e1,1,2,1,2),(p,'5m',e5,1,2,1,2);
 report := '{"multi_tf":{"1m":{"indicators":{"rsi":50,"optional":null}},"5m":{"indicators":{"rsi":55}}},"structure_by_tf":{"1m":{},"5m":{}},"patterns_by_tf":{"1m":{},"5m":{}},"setups":{"1m":{},"5m":{}}}';
 if not public.publish_short_timeframe_analysis(p,jsonb_build_object('1m',e1,'5m',e5),report) then
  raise exception 'Short publication rejected'; end if;
 if (select live_price<>123 or direction<>'Short' or analysis_input_at<>at_time-interval '1 hour'
  or multi_tf->'4h'<>'{"keep":true}'::jsonb from public.market_snapshots where pair=p) then
  raise exception 'Short publication overwrote longer analysis or live quote'; end if;
 if public.publish_short_timeframe_analysis(p,jsonb_build_object('1m',e1,'5m',e5),report) then
  raise exception 'Duplicate short version republished'; end if;
 if public.publish_short_timeframe_analysis(p,jsonb_build_object('1m',e1-3600),report) then
  raise exception 'Old short source accepted'; end if;
 select multi_tf->'1m' into original_short from public.market_snapshots where pair=p;
 insert into public.market_analysis_inputs(pair,tier,fetched_at,candles)
 select p,'core',at_time,candles from public.market_analysis_inputs where pair='EURUSD';
 if not public.publish_market_analysis(p,at_time,'{"tier":"core","anchor_interval":"4h","direction":"Long","multi_tf":{"4h":{"new":true}},"structure_by_tf":{},"patterns_by_tf":{},"setups":{}}') then
  raise exception 'Long publication rejected'; end if;
 if (select multi_tf->'1m' is distinct from original_short or short_analysis_sources->>'1m'<>e1::text
   or multi_tf->'4h'<>'{"new":true}'::jsonb from public.market_snapshots where pair=p) then
  raise exception 'Long publication erased or changed short results'; end if;
 bundle := public.get_short_analysis_bundle('EURUSD');
 if jsonb_array_length(bundle->'candles'->'1m')<>250 or jsonb_array_length(bundle->'candles'->'5m')<>250 then
  raise exception 'Expected bounded latest Deriv windows'; end if;
 if exists(select 1 from pg_proc where proname in ('get_short_analysis_bundle','publish_short_timeframe_analysis','short_timeframe_entries')
   and (prosecdef or has_function_privilege('anon',oid,'execute') or has_function_privilege('authenticated',oid,'execute'))) then
  raise exception 'Short-analysis RPC access too broad'; end if;
end;
$test$;
