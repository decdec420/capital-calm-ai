-- ============================================================
-- Archive trend-rev v1.3 per runtime audit spyros_recommendation
-- ------------------------------------------------------------
-- The runtime audit confirmed trend-rev v1.3 was flagged for
-- removal by spyros_recommendation at midnight but still showed
-- 'approved'. This migration sets it to 'archived' so signal-engine
-- no longer selects it during strategy_selection.
-- ============================================================

UPDATE public.strategies
SET
  status     = 'archived',
  updated_at = NOW()
WHERE name    = 'trend-rev'
  AND version = 'v1.3'
  AND status  = 'approved';
