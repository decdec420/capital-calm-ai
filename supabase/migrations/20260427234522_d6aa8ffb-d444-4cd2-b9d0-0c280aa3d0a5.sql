-- ============================================================
-- 1. Brain Trust short-horizon momentum
-- ============================================================
ALTER TABLE public.market_intelligence
  ADD COLUMN IF NOT EXISTS recent_momentum_1h text,
  ADD COLUMN IF NOT EXISTS recent_momentum_4h text,
  ADD COLUMN IF NOT EXISTS recent_momentum_notes text,
  ADD COLUMN IF NOT EXISTS recent_momentum_at timestamptz;

CREATE OR REPLACE FUNCTION public.validate_market_intelligence_momentum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.recent_momentum_1h IS NOT NULL
     AND NEW.recent_momentum_1h NOT IN ('up','down','flat','mixed') THEN
    RAISE EXCEPTION 'recent_momentum_1h must be one of: up, down, flat, mixed (got %)', NEW.recent_momentum_1h;
  END IF;
  IF NEW.recent_momentum_4h IS NOT NULL
     AND NEW.recent_momentum_4h NOT IN ('up','down','flat','mixed') THEN
    RAISE EXCEPTION 'recent_momentum_4h must be one of: up, down, flat, mixed (got %)', NEW.recent_momentum_4h;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_market_intelligence_momentum_trg ON public.market_intelligence;
CREATE TRIGGER validate_market_intelligence_momentum_trg
  BEFORE INSERT OR UPDATE ON public.market_intelligence
  FOR EACH ROW EXECUTE FUNCTION public.validate_market_intelligence_momentum();

-- ============================================================
-- 2. Direction basis on signals + trades
-- ============================================================
ALTER TABLE public.trade_signals
  ADD COLUMN IF NOT EXISTS direction_basis text;

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS direction_basis text;

CREATE OR REPLACE FUNCTION public.validate_direction_basis()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.direction_basis IS NOT NULL
     AND NEW.direction_basis NOT IN (
       'engine_chose_long','engine_chose_short','default_long_fallback'
     ) THEN
    RAISE EXCEPTION 'direction_basis must be one of: engine_chose_long, engine_chose_short, default_long_fallback (got %)',
      NEW.direction_basis;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_trade_signals_direction_basis_trg ON public.trade_signals;
CREATE TRIGGER validate_trade_signals_direction_basis_trg
  BEFORE INSERT OR UPDATE ON public.trade_signals
  FOR EACH ROW EXECUTE FUNCTION public.validate_direction_basis();

DROP TRIGGER IF EXISTS validate_trades_direction_basis_trg ON public.trades;
CREATE TRIGGER validate_trades_direction_basis_trg
  BEFORE INSERT OR UPDATE ON public.trades
  FOR EACH ROW EXECUTE FUNCTION public.validate_direction_basis();

-- ============================================================
-- 3. Anti-tilt: bump default consecutive_loss_limit 2 -> 4
-- ============================================================
-- Move users who are still on the system default. Users who
-- explicitly customised their doctrine (updated_via != system/default)
-- are left untouched.
UPDATE public.doctrine_settings
   SET consecutive_loss_limit = 4
 WHERE consecutive_loss_limit = 2
   AND updated_via IN ('system','default');

-- Update the new-user seed in handle_new_user(): change consecutive_loss_limit from 2 -> 4.
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
  -- consecutive_loss_limit defaults to 4 (anti-tilt hard stop). Caution
  -- and cooldown modes activate at 2 and 3 in the engine.
  INSERT INTO public.doctrine_settings (
    user_id, starting_equity_usd, max_order_pct, daily_loss_pct, floor_pct,
    max_trades_per_day, max_order_abs_cap, consecutive_loss_limit, loss_cooldown_minutes,
    risk_per_trade_pct, scan_interval_seconds, max_correlated_positions, updated_via
  ) VALUES (
    NEW.id, NULL, 0.001, 0.003, 0.80, 5, 1, 4, 30, 0.01, 300, 3, 'system'
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

  RETURN NEW;
END;
$function$;