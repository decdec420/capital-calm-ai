-- ============================================================
-- Per-user scaling doctrine + 24h tilt-protection cooldown
-- ============================================================

-- 1A. Extend doctrine_settings
ALTER TABLE public.doctrine_settings
  ADD COLUMN IF NOT EXISTS max_order_abs_floor numeric NOT NULL DEFAULT 0.25,
  ADD COLUMN IF NOT EXISTS floor_abs_min numeric NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS scan_interval_seconds integer NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS risk_per_trade_pct numeric NOT NULL DEFAULT 0.01,
  ADD COLUMN IF NOT EXISTS max_correlated_positions integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS updated_via text NOT NULL DEFAULT 'system';

-- Make starting_equity_usd nullable so onboarding can prompt for it
ALTER TABLE public.doctrine_settings
  ALTER COLUMN starting_equity_usd DROP NOT NULL,
  ALTER COLUMN starting_equity_usd DROP DEFAULT;

-- Validation trigger (CHECK constraints would be too rigid for future tweaks)
CREATE OR REPLACE FUNCTION public.validate_doctrine_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.max_order_pct < 0 OR NEW.max_order_pct > 0.5 THEN
    RAISE EXCEPTION 'max_order_pct must be in [0, 0.5] (got %)', NEW.max_order_pct;
  END IF;
  IF NEW.daily_loss_pct < 0 OR NEW.daily_loss_pct > 0.5 THEN
    RAISE EXCEPTION 'daily_loss_pct must be in [0, 0.5] (got %)', NEW.daily_loss_pct;
  END IF;
  IF NEW.floor_pct < 0.5 OR NEW.floor_pct > 0.95 THEN
    RAISE EXCEPTION 'floor_pct must be in [0.5, 0.95] (got %)', NEW.floor_pct;
  END IF;
  IF NEW.max_trades_per_day < 1 OR NEW.max_trades_per_day > 100 THEN
    RAISE EXCEPTION 'max_trades_per_day must be in [1, 100] (got %)', NEW.max_trades_per_day;
  END IF;
  IF NEW.consecutive_loss_limit < 1 OR NEW.consecutive_loss_limit > 10 THEN
    RAISE EXCEPTION 'consecutive_loss_limit must be in [1, 10] (got %)', NEW.consecutive_loss_limit;
  END IF;
  IF NEW.risk_per_trade_pct < 0 OR NEW.risk_per_trade_pct > 0.1 THEN
    RAISE EXCEPTION 'risk_per_trade_pct must be in [0, 0.1] (got %)', NEW.risk_per_trade_pct;
  END IF;
  IF NEW.starting_equity_usd IS NOT NULL AND NEW.starting_equity_usd < 1 THEN
    RAISE EXCEPTION 'starting_equity_usd must be >= 1 USD (got %)', NEW.starting_equity_usd;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_doctrine_settings_trg ON public.doctrine_settings;
CREATE TRIGGER validate_doctrine_settings_trg
BEFORE INSERT OR UPDATE ON public.doctrine_settings
FOR EACH ROW EXECUTE FUNCTION public.validate_doctrine_settings();

-- 1B. pending_doctrine_changes
CREATE TABLE IF NOT EXISTS public.pending_doctrine_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  field        text NOT NULL,
  from_value   numeric,
  to_value     numeric NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  effective_at timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  cancelled_at timestamptz,
  activated_at timestamptz,
  reason       text
);

CREATE INDEX IF NOT EXISTS idx_pending_doctrine_status_eff
  ON public.pending_doctrine_changes (status, effective_at);
CREATE INDEX IF NOT EXISTS idx_pending_doctrine_user
  ON public.pending_doctrine_changes (user_id, status);

ALTER TABLE public.pending_doctrine_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own pending_doctrine select" ON public.pending_doctrine_changes;
CREATE POLICY "own pending_doctrine select"
  ON public.pending_doctrine_changes FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "own pending_doctrine insert" ON public.pending_doctrine_changes;
CREATE POLICY "own pending_doctrine insert"
  ON public.pending_doctrine_changes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own pending_doctrine update" ON public.pending_doctrine_changes;
CREATE POLICY "own pending_doctrine update"
  ON public.pending_doctrine_changes FOR UPDATE
  USING (auth.uid() = user_id);
-- No DELETE policy = nobody can delete (audit preserved)

-- 1C. Vault token + RPC for activator cron
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'activate_doctrine_changes_cron_token') THEN
    PERFORM vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'activate_doctrine_changes_cron_token');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_activate_doctrine_changes_cron_token()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets
  WHERE name = 'activate_doctrine_changes_cron_token'
  LIMIT 1;
  RETURN v_token;
END;
$$;

-- 1D. handle_new_user — leave starting_equity_usd NULL so onboarding fills it
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  );

  INSERT INTO public.account_state (user_id) VALUES (NEW.id);
  INSERT INTO public.system_state (user_id) VALUES (NEW.id);

  -- doctrine_settings: starting_equity_usd intentionally NULL until onboarding
  INSERT INTO public.doctrine_settings (
    user_id, starting_equity_usd, max_order_pct, daily_loss_pct, floor_pct,
    max_trades_per_day, max_order_abs_cap, consecutive_loss_limit, loss_cooldown_minutes,
    risk_per_trade_pct, scan_interval_seconds, max_correlated_positions, updated_via
  ) VALUES (
    NEW.id, NULL, 0.001, 0.003, 0.80, 5, 1, 2, 30, 0.01, 300, 3, 'system'
  );

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
$$;
