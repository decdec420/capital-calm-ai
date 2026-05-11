-- =============================================================================
-- Migration: tune_strategy_doctrine
-- Date: 2026-05-11
-- Purpose: Fix 13-day dry spell caused by gap in trending_up regime coverage.
--
-- ROOT CAUSE:
--   When crypto is trending_up with RSI ≥ 75, trend-following strategies
--   correctly reject late longs but vwap-revert (the short/fade strategy)
--   was restricted to range/chop regimes only — leaving nothing to trade.
--
-- DOCTRINE CHANGES:
--   1. vwap-revert: Add trending_up to regime_affinity so it can execute
--      mean-reversion shorts when an uptrend becomes RSI-overextended.
--      Guarded by rsi_trending_short_min=75 so it only triggers at genuine
--      exhaustion levels (not every pullback in a trend).
--
--   2. vwap-revert: Add rsi_fast_period=7 for faster RSI timing in
--      trending fades. The standard 14-period RSI lags too much for
--      counter-trend entries; 7-period responds to exhaustion earlier.
--
--   3. momentum-burst + trend-pullback: Add rsi_max=72 to prevent buying
--      into overextended conditions. These strategies should only enter
--      when there is room to run — not at RSI extremes where reversal
--      risk outweighs continuation probability.
--
-- All updates are idempotent (safe to run twice).
-- =============================================================================

-- 1. Allow vwap-revert to run in trending_up regime
--    (Only adds the value if it is not already present.)
UPDATE public.strategies
SET regime_affinity = array_append(regime_affinity, 'trending_up')
WHERE name = 'vwap-revert'
  AND status = 'approved'
  AND NOT ('trending_up' = ANY(regime_affinity));

-- 2. Add rsi_trending_short_min and rsi_fast_period params to vwap-revert.
--    Uses a remove-then-append pattern so the update is idempotent.
UPDATE public.strategies
SET params = (
  SELECT jsonb_agg(p)
  FROM jsonb_array_elements(COALESCE(params, '[]'::jsonb)) AS p
  WHERE p->>'key' NOT IN ('rsi_trending_short_min', 'rsi_fast_period')
) || '[{"key":"rsi_trending_short_min","value":75},{"key":"rsi_fast_period","value":7}]'::jsonb
WHERE name = 'vwap-revert' AND status = 'approved';

-- 3. Add rsi_max=72 to momentum-burst and trend-pullback.
--    Prevents entries when RSI is already overextended (≥ 72) — no room to run.
--    Uses the same idempotent remove-then-append pattern.
UPDATE public.strategies
SET params = (
  SELECT jsonb_agg(p)
  FROM jsonb_array_elements(COALESCE(params, '[]'::jsonb)) AS p
  WHERE p->>'key' NOT IN ('rsi_max')
) || '[{"key":"rsi_max","value":72}]'::jsonb
WHERE name IN ('momentum-burst', 'trend-pullback')
  AND status = 'approved';
