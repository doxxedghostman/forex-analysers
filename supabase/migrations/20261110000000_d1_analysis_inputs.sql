-- Move the analyser's candle-input reads to the authenticated Cloudflare D1 API.
-- Supabase remains the destination for market_snapshots and market_sentiment.

CREATE OR REPLACE FUNCTION public.publish_market_analysis_from_d1(
  p_pair text,
  p_input_at timestamptz,
  p_source_candle_epoch numeric,
  p_analysis jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE changed integer;
BEGIN
  IF p_source_candle_epoch IS NULL OR p_source_candle_epoch <= 0
    OR p_source_candle_epoch > extract(epoch FROM clock_timestamp() + interval '5 minutes') THEN
    RAISE EXCEPTION 'Invalid D1 source timestamp for %', p_pair;
  END IF;
  UPDATE public.market_snapshots AS existing SET
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
    multi_tf=computed.multi_tf || public.short_timeframe_entries(existing.multi_tf),
    smc=computed.smc,
    structure_by_tf=computed.structure_by_tf || public.short_timeframe_entries(existing.structure_by_tf),
    patterns_by_tf=computed.patterns_by_tf || public.short_timeframe_entries(existing.patterns_by_tf),
    setups=computed.setups || public.short_timeframe_entries(existing.setups),
    weekly_trend=computed.weekly_trend,
    is_stale=false,
    last_error=null,
    updated_at=clock_timestamp(),
    source_candle_at=to_timestamp(p_source_candle_epoch::double precision),
    analysis_input_at=p_input_at
  FROM jsonb_populate_record(null::public.market_snapshots,p_analysis) AS computed
  WHERE existing.pair=p_pair
    AND (existing.analysis_input_at IS NULL OR existing.analysis_input_at < p_input_at);
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_market_analysis_from_d1(text,timestamptz,numeric,jsonb) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_market_analysis_from_d1(text,timestamptz,numeric,jsonb) TO service_role;

-- Short candles are now fetched and validated by the analyser from D1.
-- Keep the Supabase RPC as the atomic snapshot writer, but remove its old
-- requirement that the same Deriv candles also exist in Supabase.
DO $migration$
DECLARE definition text; old_check text;
BEGIN
  definition := pg_get_functiondef('public.publish_short_timeframe_analysis(text,jsonb,jsonb)'::regprocedure);
  old_check := $old$    if not exists(select 1 from public.deriv_candles where symbol=p_pair and timeframe=tf and epoch=incoming) then
      raise exception 'Short analysis source does not exist for % %',p_pair,tf;
    end if;
$old$;
  IF position(old_check IN definition) = 0 THEN
    RAISE EXCEPTION 'Could not locate legacy deriv_candles validation in publish_short_timeframe_analysis; no function changed';
  END IF;
  definition := replace(definition, old_check, '');
  EXECUTE definition;
END;
$migration$;

NOTIFY pgrst,'reload schema';