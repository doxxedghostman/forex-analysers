-- Independent short-frame versions avoid copying Deriv history into every
-- Yahoo/long-frame handoff, or recalculating an unchanged 4H recommendation.
alter table public.market_snapshots add column if not exists short_analysis_sources jsonb not null default '{}'::jsonb;

create or replace function public.get_short_analysis_bundle(p_pair text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with frames(tf,seconds) as (values ('1m',60),('5m',300)), short as (
    select tf,coalesce(jsonb_agg(jsonb_build_object('timestamp',epoch,
      'open',open,'high',high,'low',low,'close',close) order by epoch)
      filter(where epoch is not null),'[]'::jsonb) candles
    from frames left join lateral (
      select epoch,open,high,low,close from public.deriv_candles
      where symbol=p_pair and timeframe=tf and epoch+seconds<=extract(epoch from now())
      order by epoch desc limit 250
    ) d on true group by tf
  ), context as (
    select key as tf,value->'indicators' as indicators from public.market_snapshots s,
      lateral jsonb_each(s.multi_tf) where s.pair=p_pair
      and s.source_candle_at>=now()-interval '1 hour' and s.analysis_input_at is not null
      and key in ('15m','1h','4h','1d')
  ) select jsonb_build_object('candles',(select jsonb_object_agg(tf,candles) from short),
    'higher_indicators',coalesce((select jsonb_object_agg(tf,jsonb_build_object(
      'ema_200',indicators->'ema_200','rsi',indicators->'rsi',
      'macd',case when jsonb_typeof(indicators->'macd')='array' then indicators->'macd'->-1 else indicators->'macd' end,
      'macd_signal',case when jsonb_typeof(indicators->'macd_signal')='array' then indicators->'macd_signal'->-1 else indicators->'macd_signal' end,
      'supertrend',indicators->'supertrend'
    )) from context),'{}'::jsonb));
$$;

create or replace function public.publish_short_timeframe_analysis(p_pair text,p_sources jsonb,p_analysis jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  tf text; incoming bigint; previous_sources jsonb; accepted jsonb := '{}';
  summaries jsonb := '{}'; structures jsonb := '{}'; patterns jsonb := '{}'; setup_values jsonb := '{}';
  seconds integer; age_limit integer;
begin
  select short_analysis_sources into previous_sources from public.market_snapshots where pair=p_pair for update;
  if not found then return false; end if;
  foreach tf in array array['1m','5m'] loop
    incoming := (p_sources->>tf)::bigint;
    seconds := case when tf='1m' then 60 else 300 end;
    age_limit := case when tf='1m' then 180 else 750 end;
    if incoming is null or incoming<=coalesce((previous_sources->>tf)::bigint,0) then continue; end if;
    if incoming+seconds>extract(epoch from now()) or incoming<extract(epoch from now())-age_limit
      or mod(incoming,seconds)<>0 then continue; end if;
    if not exists(select 1 from public.deriv_candles where symbol=p_pair and timeframe=tf and epoch=incoming) then
      raise exception 'Short analysis source does not exist for % %',p_pair,tf;
    end if;
    if jsonb_typeof(p_analysis->'multi_tf'->tf) is distinct from 'object'
      or jsonb_typeof(p_analysis->'structure_by_tf'->tf) is distinct from 'object'
      or jsonb_typeof(p_analysis->'patterns_by_tf'->tf) is distinct from 'object'
      or jsonb_typeof(p_analysis->'setups'->tf) is distinct from 'object' then
      raise exception 'Incomplete short analysis for % %',p_pair,tf;
    end if;
    accepted := accepted || jsonb_build_object(tf,incoming);
    summaries := summaries || jsonb_build_object(tf,(p_analysis->'multi_tf'->tf) || jsonb_build_object(
      'source','deriv','source_candle_at',to_timestamp(incoming),'analysis_at',clock_timestamp(),'closed_candles',true));
    structures := structures || jsonb_build_object(tf,p_analysis->'structure_by_tf'->tf);
    patterns := patterns || jsonb_build_object(tf,p_analysis->'patterns_by_tf'->tf);
    setup_values := setup_values || jsonb_build_object(tf,p_analysis->'setups'->tf);
  end loop;
  if accepted='{}'::jsonb then return false; end if;
  update public.market_snapshots set
    multi_tf=coalesce(multi_tf,'{}') || summaries,
    structure_by_tf=coalesce(structure_by_tf,'{}') || structures,
    patterns_by_tf=coalesce(patterns_by_tf,'{}') || patterns,
    setups=coalesce(setups,'{}') || setup_values,
    short_analysis_sources=short_analysis_sources || accepted
    where pair=p_pair;
  return true;
end;
$$;

-- Longer-timeframe publishes must preserve independently refreshed short
-- entries. The remaining atomic input-version check and assignments are
-- unchanged from the existing publish_market_analysis function.
create or replace function public.short_timeframe_entries(p_value jsonb)
returns jsonb language sql immutable security invoker set search_path = '' as $$
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(coalesce(p_value,'{}'::jsonb))
  where key in ('1m','5m');
$$;

do $patch$
declare definition text;
begin
  definition := pg_get_functiondef('public.publish_market_analysis(text,timestamptz,jsonb)'::regprocedure);
  definition := replace(definition,'multi_tf=computed.multi_tf,',
    'multi_tf=computed.multi_tf || public.short_timeframe_entries(existing.multi_tf),');
  definition := replace(definition,'structure_by_tf=computed.structure_by_tf,',
    'structure_by_tf=computed.structure_by_tf || public.short_timeframe_entries(existing.structure_by_tf),');
  definition := replace(definition,'patterns_by_tf=computed.patterns_by_tf,',
    'patterns_by_tf=computed.patterns_by_tf || public.short_timeframe_entries(existing.patterns_by_tf),');
  definition := replace(definition,'setups=computed.setups,',
    'setups=computed.setups || public.short_timeframe_entries(existing.setups),');
  if definition not like '%multi_tf=computed.multi_tf ||%' or definition not like '%setups=computed.setups ||%' then
    raise exception 'Unexpected existing publish_market_analysis definition; migration aborted';
  end if;
  execute definition;
end;
$patch$;

revoke all on function public.get_short_analysis_bundle(text) from public,anon,authenticated;
revoke all on function public.publish_short_timeframe_analysis(text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.short_timeframe_entries(jsonb) from public,anon,authenticated;
grant execute on function public.get_short_analysis_bundle(text),public.publish_short_timeframe_analysis(text,jsonb,jsonb),public.short_timeframe_entries(jsonb) to service_role;
notify pgrst,'reload schema';
