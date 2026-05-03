-- Phase 4: extend new-user provisioning so every account ships
-- with three strategies (one approved baseline + two candidates)
-- covering complementary regimes. The router picks among them
-- per signal based on regime and side affinity.

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  );

  INSERT INTO public.account_state (user_id) VALUES (NEW.id);
  INSERT INTO public.system_state (user_id) VALUES (NEW.id);

  INSERT INTO public.doctrine_settings (
    user_id, starting_equity_usd, max_order_pct, daily_loss_pct, floor_pct,
    max_trades_per_day, max_order_abs_cap, consecutive_loss_limit, loss_cooldown_minutes,
    risk_per_trade_pct, scan_interval_seconds, max_correlated_positions, updated_via
  ) VALUES (
    NEW.id, NULL, 0.001, 0.003, 0.80, 5, 1, 4, 30, 0.01, 300, 3, 'system'
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- Baseline approved strategy (existing).
  INSERT INTO public.strategies (
    user_id, name, version, status, description, params, metrics,
    risk_weight, regime_affinity, side_capability
  )
  VALUES (
    NEW.id, 'trend-rev', 'v1.3', 'approved',
    'Trend-following with mean-reversion exits. Conservative sizing.',
    '[
      {"key":"rsi_period","value":14},
      {"key":"ema_fast","value":9},
      {"key":"ema_slow","value":21},
      {"key":"max_order_pct","value":0.25,"unit":"%"},
      {"key":"stop_atr_mult","value":1.5},
      {"key":"tp_r_mult","value":2.0}
    ]'::jsonb,
    '{"expectancy":0.42,"winRate":0.58,"maxDrawdown":-3.1,"sharpe":1.42,"trades":127}'::jsonb,
    1.0,
    ARRAY['trending_up','trending_down','breakout']::text[],
    ARRAY['long','short']::text[]
  );

  -- Phase 4: VWAP mean-reversion specialist. Activates in chop/range,
  -- both directions, slightly tighter stop and lower TP because reversion
  -- trades exit at the mean rather than ride a trend.
  INSERT INTO public.strategies (
    user_id, name, version, status, description, params, metrics,
    risk_weight, regime_affinity, side_capability
  ) VALUES (
    NEW.id, 'vwap-revert', 'v1.0', 'candidate',
    'Mean-reversion to VWAP/EMA in range and chop regimes. Both directions. Tight stops, modest targets.',
    '[
      {"key":"rsi_period","value":7},
      {"key":"ema_fast","value":8},
      {"key":"ema_slow","value":34},
      {"key":"max_order_pct","value":0.15,"unit":"%"},
      {"key":"stop_atr_mult","value":1.0},
      {"key":"tp_r_mult","value":1.2}
    ]'::jsonb,
    '{"expectancy":0,"winRate":0,"maxDrawdown":0,"sharpe":0,"trades":0}'::jsonb,
    0.7,
    ARRAY['range','chop']::text[],
    ARRAY['long','short']::text[]
  );

  -- Phase 4: momentum-burst — long-only breakout chaser. Activates only
  -- in confirmed breakouts and strong uptrends. Wider stop, longer TP
  -- because it's riding rather than fading.
  INSERT INTO public.strategies (
    user_id, name, version, status, description, params, metrics,
    risk_weight, regime_affinity, side_capability
  ) VALUES (
    NEW.id, 'momentum-burst', 'v1.0', 'candidate',
    'Long-only momentum chaser. Activates in breakout and strong-uptrend regimes. Wide stop, longer runner.',
    '[
      {"key":"rsi_period","value":14},
      {"key":"ema_fast","value":12},
      {"key":"ema_slow","value":26},
      {"key":"max_order_pct","value":0.20,"unit":"%"},
      {"key":"stop_atr_mult","value":2.0},
      {"key":"tp_r_mult","value":2.8}
    ]'::jsonb,
    '{"expectancy":0,"winRate":0,"maxDrawdown":0,"sharpe":0,"trades":0}'::jsonb,
    0.8,
    ARRAY['breakout','trending_up']::text[],
    ARRAY['long']::text[]
  );

  RETURN NEW;
END;
$function$;