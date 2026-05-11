-- ============================================================
-- Fix doctrine sizing — auto-scaling trade sizes
-- ------------------------------------------------------------
-- Problem: the original onboarding seed used ultra-conservative
-- sentinel defaults (max_order_pct=0.1%, max_order_abs_cap=$1)
-- which produce $0.25 trades on a $50 account. The kill-switch
-- floor at 80% of starting equity compounded the problem by
-- blocking any order larger than $10 on a $50 account.
--
-- Goal: math that auto-scales with deposit size:
--   $10  equity → ~$2.50 per trade
--   $50  equity → ~$12.50 per trade
--   $200 equity → ~$50   per trade
--   $1k  equity → ~$250  per trade
--
-- The formula: maxOrderUsd = clamp(equity × 25%, $1, $1000)
-- Risk stays bounded: 2% of equity risked per trade, not 25%.
-- The 25% is position concentration cap; actual $ at risk is
-- determined by stop distance (typically 0.5-1% of notional).
-- ============================================================

-- ── 1. Update existing doctrine_settings ─────────────────────
-- Guard: only update rows that are still at the factory sentinel
-- defaults (max_order_pct ≤ 0.005) and have not been deliberately
-- edited by the user (updated_via != 'user').
-- This preserves any deliberate manual tuning.

UPDATE public.doctrine_settings
SET
  max_order_pct           = 0.25,   -- 25% of equity (was 0.1%)
  max_order_abs_cap       = 1000,   -- let % do the work (was $1)
  max_order_abs_floor     = 1.00,   -- minimum $1 order (was $0.25)
  floor_pct               = 0.65,   -- kill-switch at 65% of start (was 80%)
  floor_abs_min           = 8,      -- never below $8 (was $5)
  risk_per_trade_pct      = 0.02,   -- 2% risk per trade (was 1%)
  daily_loss_pct          = 0.05,   -- 5% daily loss cap (was 0.3/2%)
  max_trades_per_day      = 10,     -- 10/day (was 5)
  updated_via             = 'fix_doctrine_sizing_migration',
  updated_at              = NOW()
WHERE max_order_pct <= 0.005        -- still at sentinel factory default
  AND (updated_via IS NULL OR updated_via NOT IN ('user'));

-- ── 2. Update handle_new_user() — new users get sensible defaults ─

CREATE OR REPLACE FUNCTION public.handle_new_user()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  );

  INSERT INTO public.account_state  (user_id) VALUES (NEW.id);
  INSERT INTO public.system_state   (user_id) VALUES (NEW.id);

  -- Doctrine defaults: auto-scaling by equity.
  -- max_order_pct=25% means $50→$12.50, $200→$50, $1k→$250 per trade.
  -- risk_per_trade_pct=2% controls actual $ at risk (stop distance math).
  INSERT INTO public.doctrine_settings (
    user_id, starting_equity_usd,
    max_order_pct, max_order_abs_cap, max_order_abs_floor,
    daily_loss_pct, floor_pct, floor_abs_min,
    max_trades_per_day, consecutive_loss_limit, loss_cooldown_minutes,
    risk_per_trade_pct, scan_interval_seconds, max_correlated_positions,
    updated_via
  ) VALUES (
    NEW.id, NULL,
    0.25,   1000,  1.00,
    0.05,   0.65,  8,
    10,     4,     30,
    0.02,   300,   3,
    'system'
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- Seed approved strategies (momentum-burst, vwap-revert, trend-pullback,
  -- breakout-confirm, range-fade) — same as previous handle_new_user.
  INSERT INTO public.strategies (
    user_id, name, version, status, description, params, metrics,
    risk_weight, regime_affinity, side_capability
  ) VALUES
    (NEW.id, 'momentum-burst', 'v1.0', 'approved',
     'Breakout momentum with volume confirmation. Rides explosive moves.',
     '[{"key":"rsi_period","value":14},{"key":"ema_fast","value":9},{"key":"ema_slow","value":21},{"key":"stop_atr_mult","value":1.5},{"key":"tp_r_mult","value":2.0},{"key":"rsi_max","value":72}]'::jsonb,
     '{"expectancy":0.0,"winRate":0.0,"maxDrawdown":0.0,"sharpe":0.0,"trades":0}'::jsonb,
     1.0, ARRAY['breakout','trending_up'], ARRAY['long']),

    (NEW.id, 'vwap-revert', 'v1.0', 'approved',
     'Mean-reversion fade at RSI extremes. Shorts overbought, longs oversold.',
     '[{"key":"rsi_period","value":14},{"key":"ema_fast","value":9},{"key":"ema_slow","value":21},{"key":"stop_atr_mult","value":1.0},{"key":"tp_r_mult","value":1.5},{"key":"rsi_trending_short_min","value":75},{"key":"rsi_fast_period","value":7}]'::jsonb,
     '{"expectancy":0.0,"winRate":0.0,"maxDrawdown":0.0,"sharpe":0.0,"trades":0}'::jsonb,
     1.0, ARRAY['range','chop','trending_up'], ARRAY['long','short']),

    (NEW.id, 'trend-pullback', 'v1.0', 'approved',
     'Buy-the-dip in an established uptrend. Waits for RSI cooloff and EMA touch.',
     '[{"key":"rsi_period","value":14},{"key":"ema_fast","value":9},{"key":"ema_slow","value":21},{"key":"stop_atr_mult","value":1.5},{"key":"tp_r_mult","value":2.0},{"key":"rsi_max","value":72}]'::jsonb,
     '{"expectancy":0.0,"winRate":0.0,"maxDrawdown":0.0,"sharpe":0.0,"trades":0}'::jsonb,
     1.0, ARRAY['trending_up','breakout'], ARRAY['long']),

    (NEW.id, 'breakout-confirm', 'v1.0', 'approved',
     'Breakout above 20-bar high with volume. Confirmation entry, not anticipation.',
     '[{"key":"rsi_period","value":14},{"key":"ema_fast","value":9},{"key":"ema_slow","value":21},{"key":"stop_atr_mult","value":2.0},{"key":"tp_r_mult","value":3.0}]'::jsonb,
     '{"expectancy":0.0,"winRate":0.0,"maxDrawdown":0.0,"sharpe":0.0,"trades":0}'::jsonb,
     1.0, ARRAY['breakout'], ARRAY['long']),

    (NEW.id, 'range-fade', 'v1.0', 'approved',
     'Fade range extremes. Long at oversold support, short at overbought resistance.',
     '[{"key":"rsi_period","value":14},{"key":"ema_fast","value":9},{"key":"ema_slow","value":21},{"key":"stop_atr_mult","value":1.0},{"key":"tp_r_mult","value":1.5}]'::jsonb,
     '{"expectancy":0.0,"winRate":0.0,"maxDrawdown":0.0,"sharpe":0.0,"trades":0}'::jsonb,
     1.0, ARRAY['range'], ARRAY['long','short'])
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;
