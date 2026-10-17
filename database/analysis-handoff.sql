-- Additive handoff schema. Existing combined cron remains compatible.
create table if not exists public.market_analysis_inputs (
  pair text primary key,
  tier text not null,
  candles jsonb not null check (jsonb_typeof(candles) = 'object'),
  fetched_at timestamptz not null
);
alter table public.market_analysis_inputs enable row level security;
revoke all on public.market_analysis_inputs from public, anon, authenticated;
grant select, insert, update, delete on public.market_analysis_inputs to service_role;

alter table public.market_snapshots add column if not exists analysis_input_at timestamptz;

-- Serializes overlapping collectors; a slower old request cannot replace newer input.
create or replace function public.publish_market_analysis_input(
  p_pair text, p_tier text, p_candles jsonb, p_fetched_at timestamptz
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare changed integer;
begin
  insert into public.market_analysis_inputs as existing (pair,tier,candles,fetched_at)
  values (p_pair,p_tier,p_candles,p_fetched_at)
  on conflict(pair) do update set tier=excluded.tier, candles=excluded.candles, fetched_at=excluded.fetched_at
  where existing.fetched_at < excluded.fetched_at;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;
revoke all on function public.publish_market_analysis_input(text,text,jsonb,timestamptz) from public, anon, authenticated;
grant execute on function public.publish_market_analysis_input(text,text,jsonb,timestamptz) to service_role;

-- Atomic version check + publish. Only analysis columns are assigned: quotes,
-- price timestamps, chart history, and alert state are never overwritten here.
create or replace function public.publish_market_analysis(
  p_pair text, p_input_at timestamptz, p_analysis jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare current_input_at timestamptz; changed integer;
begin
  select fetched_at into current_input_at from public.market_analysis_inputs
  where pair=p_pair for update;
  if current_input_at is null or current_input_at <> p_input_at then return false; end if;
  update public.market_snapshots as existing set
    tier=computed.tier,
    anchor_interval=computed.anchor_interval,
    direction=computed.direction,
    confidence_score=computed.confidence_score,
    trade_strength=computed.trade_strength,
    market_state=computed.market_state,
    preferred=computed.preferred,
    base_long=computed.base_long,
    base_short=computed.base_short,
    reasoning=computed.reasoning,
    multi_tf=computed.multi_tf,
    smc=computed.smc,
    structure_by_tf=computed.structure_by_tf,
    patterns_by_tf=computed.patterns_by_tf,
    setups=computed.setups,
    weekly_trend=computed.weekly_trend,
    is_stale=false,
    last_error=null,
    updated_at=clock_timestamp(),
    analysis_input_at=p_input_at
  from jsonb_populate_record(null::public.market_snapshots,p_analysis) as computed
  where existing.pair=p_pair
    and (existing.analysis_input_at is null or existing.analysis_input_at < p_input_at);
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;
revoke all on function public.publish_market_analysis(text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.publish_market_analysis(text,timestamptz,jsonb) to service_role;
