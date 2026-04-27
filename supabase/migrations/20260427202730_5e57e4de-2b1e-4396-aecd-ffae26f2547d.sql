-- 1. Rewrite handle_new_user() to drop the guardrails seed.
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

  -- doctrine_settings: starting_equity_usd intentionally NULL until onboarding.
  INSERT INTO public.doctrine_settings (
    user_id, starting_equity_usd, max_order_pct, daily_loss_pct, floor_pct,
    max_trades_per_day, max_order_abs_cap, consecutive_loss_limit, loss_cooldown_minutes,
    risk_per_trade_pct, scan_interval_seconds, max_correlated_positions, updated_via
  ) VALUES (
    NEW.id, NULL, 0.001, 0.003, 0.80, 5, 1, 2, 30, 0.01, 300, 3, 'system'
  )
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.strategies (user_id, name, version, status, description, params, metrics)
  VALUES (
    NEW.id, 'trend-rev', 'v1.3', 'approved',
    'Trend-following with mean-reversion exits. Conservative sizing.',
    '[
      {"key":"rsi_period","value":14},
      {"key":"ema_fast","value":9},
      {"key":"ema_slow","value":21},
      {"key":"max_order_pct","value":0.25,"unit":"%"},
      {"key":"stop_atr_mult","value":1.5}
    ]'::jsonb,
    '{"expectancy":0.42,"winRate":0.58,"maxDrawdown":-3.1,"sharpe":1.42,"trades":127}'::jsonb
  );

  -- NOTE: legacy 'guardrails' seed removed. Custom annotations are now opt-in
  -- user notes — see DoctrineGuardrailGrid for what the engine actually enforces.

  RETURN NEW;
END;
$function$;

-- 2. Clean up seeded fake rows for existing users.
-- Match by (label + current_value) pairs from the original seed, so we never
-- touch a real user-authored annotation that happens to share a label.
DELETE FROM public.guardrails
WHERE
  (label = 'Max order size'    AND current_value = '0.18%'   AND limit_value = '0.25%')
  OR (label = 'Daily loss cap'    AND current_value = '0.27%'   AND limit_value = '1.50%')
  OR (label = 'Daily trade cap'   AND current_value = '3'       AND limit_value = '6')
  OR (label = 'Balance floor'     AND current_value = '$10,000' AND limit_value = '$9,500')
  OR (label = 'Spread filter'     AND current_value = '2.1 bps' AND limit_value = '5.0 bps')
  OR (label = 'Stale data'        AND current_value = '0.4s'    AND limit_value = '5.0s')
  OR (label = 'Drawdown'          AND current_value = '-1.2%'   AND limit_value = '-5.0%')
  OR (label = 'Latency'           AND current_value = '42ms'    AND limit_value = '250ms');