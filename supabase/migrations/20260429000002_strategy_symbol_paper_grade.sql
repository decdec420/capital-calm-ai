-- ============================================================
-- Migration: strategy symbol + paper_grade on trade_signals
-- ============================================================
-- 1. strategies.symbol — which symbol this strategy was designed for.
--    NULL = symbol-agnostic (legacy rows). Used by Katrina to bucket
--    strategies per symbol and by the UI to show symbol badges.
-- 2. trade_signals.paper_grade — true when the signal was generated
--    in paper mode. Allows the Trade Coach to weight live vs paper
--    results separately when computing calibration deltas.
-- ============================================================

-- 1. strategies.symbol
ALTER TABLE public.strategies
  ADD COLUMN IF NOT EXISTS symbol TEXT;

COMMENT ON COLUMN public.strategies.symbol IS
  'Whitelist symbol this strategy targets (BTC-USD, ETH-USD, SOL-USD). NULL = symbol-agnostic.';

CREATE INDEX IF NOT EXISTS idx_strategies_user_symbol
  ON public.strategies(user_id, symbol);

-- 2. trade_signals.paper_grade
ALTER TABLE public.trade_signals
  ADD COLUMN IF NOT EXISTS paper_grade BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.trade_signals.paper_grade IS
  'TRUE when the signal was generated in paper mode. Used by post-trade-learn to weight calibration separately from live signals.';

CREATE INDEX IF NOT EXISTS idx_trade_signals_paper_grade
  ON public.trade_signals(user_id, paper_grade);
