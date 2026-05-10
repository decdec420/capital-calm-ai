-- =============================================================================
-- PR #41 — Accepted Recommendation → Queued Experiment Proposal
-- =============================================================================
-- Adds two columns to experiments so a proposal can be traced back to the
-- strategy_learning_recommendation that inspired it.
--
-- Safety invariants:
--   - These columns are metadata only; they do not trigger any execution.
--   - Adding source_recommendation_id does NOT auto-run the experiment.
--   - The experiment pipeline (run-experiment cron) only processes rows with
--     status = 'queued'. Learning-sourced proposals use status = 'needs_review'
--     so they are NOT auto-run.
--   - No strategy, doctrine, or risk gate is mutated here.
-- =============================================================================

-- ── source: who/what generated this experiment row ───────────────────────────
-- Existing values: 'user', 'copilot', 'coach'
-- New value added: 'strategy_learning' (from an accepted recommendation)
ALTER TABLE public.experiments
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'user';

COMMENT ON COLUMN public.experiments.source IS
  'Origin of this experiment proposal. '
  '''user'': created manually by the operator. '
  '''copilot'': proposed by the AI copilot cron. '
  '''coach'': proposed by the coach agent. '
  '''strategy_learning'': queued from an accepted strategy learning recommendation.';

-- ── source_recommendation_id: FK back to the originating recommendation ──────
ALTER TABLE public.experiments
  ADD COLUMN IF NOT EXISTS source_recommendation_id uuid NULL
    REFERENCES public.strategy_learning_recommendations(id)
    ON DELETE SET NULL;

COMMENT ON COLUMN public.experiments.source_recommendation_id IS
  'When source = ''strategy_learning'', this is the UUID of the '
  'strategy_learning_recommendations row that was accepted and then used to '
  'create this experiment proposal. NULL for all other sources.';

-- Index for fast deduplication lookup (prevent duplicate proposals per recommendation)
CREATE INDEX IF NOT EXISTS idx_experiments_source_recommendation
  ON public.experiments (source_recommendation_id)
  WHERE source_recommendation_id IS NOT NULL;

-- ── Back-fill proposed_by for existing rows (was already set, no-op safe) ─────
-- No back-fill needed: existing rows predate this column and keep source='user'.
