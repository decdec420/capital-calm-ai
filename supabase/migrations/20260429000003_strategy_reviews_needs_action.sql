-- ============================================================
-- Migration: strategy_reviews.needs_action flag
-- ============================================================
-- Lets Wags (copilot-chat) know when Katrina has produce/kill
-- recommendations that require operator review.
-- ============================================================

ALTER TABLE public.strategy_reviews
  ADD COLUMN IF NOT EXISTS needs_action BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.strategy_reviews.needs_action IS
  'TRUE when Katrina found strategies to promote or kill. Cleared when Wags acknowledges.';

CREATE INDEX IF NOT EXISTS idx_strategy_reviews_needs_action
  ON public.strategy_reviews(user_id, needs_action)
  WHERE needs_action = TRUE;
