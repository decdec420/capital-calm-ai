-- ============================================================
-- Approve vwap-revert and momentum-burst candidate strategies
-- ------------------------------------------------------------
-- Both strategies have been at "candidate" status since creation.
-- The signal-engine only loads "approved" strategies, so Taylor
-- has never been able to select them.
--
-- vwap-revert:    range/chop affinity, long+short. Mean-reversion
--                 to VWAP/EMA. Newly unlocked by range regime being
--                 added to TRADEABLE_REGIMES.
--
-- momentum-burst: breakout/trending_up affinity, long only.
--                 Breakout confirmation chaser. Complementary to
--                 trend-pullback in uptrend/breakout regimes.
-- ============================================================

UPDATE public.strategies
SET
  status = 'approved',
  updated_at = now()
WHERE
  name IN ('vwap-revert', 'momentum-burst')
  AND status = 'candidate';
