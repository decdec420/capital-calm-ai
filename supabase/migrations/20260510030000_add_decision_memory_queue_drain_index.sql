-- =============================================================================
-- PR #37 fixup: add ASC queue-drain index on decision_memory
-- =============================================================================
-- The process-decision-memory function drains rows with:
--   WHERE user_id = $1 AND used_for_learning = false
--   ORDER BY created_at ASC
-- The existing idx_decision_memory_unlearned uses created_at DESC, which
-- causes a reverse scan for the oldest-first drain pattern.
-- This index matches the drain query exactly so the planner reads it in
-- natural forward order without a sort step.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_decision_memory_queue_drain
  ON public.decision_memory (user_id, used_for_learning, created_at ASC)
  WHERE used_for_learning = false;
