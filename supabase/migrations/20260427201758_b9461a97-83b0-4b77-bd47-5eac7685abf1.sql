-- P2-A: Make doctrine_settings seed in handle_new_user idempotent.
-- The existing function already inserts a doctrine_settings row, but a plain
-- INSERT would fail on replay (unique constraint on user_id). Adding
-- ON CONFLICT DO NOTHING makes the function safe to re-run without ever
-- clobbering an operator's tuned settings.
--
-- All other inserts (profiles, account_state, system_state, strategies,
-- guardrails) are left exactly as-is. Defaults for doctrine_settings are
-- preserved from the prior version of this function so they continue to
-- satisfy the existing CHECK constraints and validate_doctrine_settings
-- trigger (mode in ('preserve','hunt'); starting_equity_usd NULL until the
-- operator funds the account).

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
  -- ON CONFLICT DO NOTHING makes the seed idempotent — never overwrites a
  -- user's tuned values on replay.
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

  INSERT INTO public.guardrails (user_id, label, description, current_value, limit_value, level, utilization, sort_order) VALUES
    (NEW.id, 'Max order size', 'Largest single order vs equity', '0.18%', '0.25%', 'safe', 0.72, 1),
    (NEW.id, 'Daily loss cap', 'Total losses today vs cap', '0.27%', '1.50%', 'safe', 0.18, 2),
    (NEW.id, 'Daily trade cap', 'Trades placed today', '3', '6', 'safe', 0.5, 3),
    (NEW.id, 'Balance floor', 'Equity vs hard floor', '$10,000', '$9,500', 'safe', 0.05, 4),
    (NEW.id, 'Spread filter', 'Current spread vs max', '2.1 bps', '5.0 bps', 'safe', 0.42, 5),
    (NEW.id, 'Stale data', 'Seconds since last tick', '0.4s', '5.0s', 'safe', 0.08, 6),
    (NEW.id, 'Drawdown', 'Peak-to-trough drawdown', '-1.2%', '-5.0%', 'safe', 0.24, 7),
    (NEW.id, 'Latency', 'Round-trip to broker', '42ms', '250ms', 'safe', 0.17, 8);

  RETURN NEW;
END;
$function$;