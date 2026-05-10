-- =============================================================================
-- PR #39 — Batch Simulation Queue: extend decision_memory_simulations
-- =============================================================================
-- The table was created in 20260510020000 (PR #38 — Outcome Enrichment).
-- This migration adds the columns and constraints needed by the
-- process-decision-memory queue drainer (PR #39).
--
-- Columns added:
--   symbol          — denormalized from decision_memory for per-symbol queries
--   strategy_id     — strategy in scope at decision time (nullable)
--   input_snapshot  — non-sensitive copy of decision context at job creation
--   score           — summary quality score (0–1, geometric mean of
--                     setup_score × confidence), for easy sorting
--   started_at      — when the job transitioned to 'running'
--   completed_at    — when the job transitioned to 'completed' or 'failed'
--
-- Constraints added:
--   chk_dms_simulation_type — enforce valid simulation_type values
--   chk_dms_status          — enforce valid lifecycle status values
--   chk_dms_score           — enforce score ∈ [0, 1] when not null
--   decision_memory_simulations_unique_job — prevent duplicate jobs from
--     concurrent drain invocations (process-decision-memory + cron overlap)
--
-- Safety: no execution triggers, no credential storage, read-only for users.
-- =============================================================================

ALTER TABLE public.decision_memory_simulations
  ADD COLUMN IF NOT EXISTS symbol        text        NULL,
  ADD COLUMN IF NOT EXISTS strategy_id   uuid        NULL,
  ADD COLUMN IF NOT EXISTS input_snapshot jsonb       NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS score         numeric     NULL,
  ADD COLUMN IF NOT EXISTS started_at    timestamptz NULL,
  ADD COLUMN IF NOT EXISTS completed_at  timestamptz NULL;

-- ── CHECK constraints ─────────────────────────────────────────────────────────

ALTER TABLE public.decision_memory_simulations
  ADD CONSTRAINT chk_dms_simulation_type
    CHECK (simulation_type IN ('TAKEN_IF_NOT_BLOCKED', 'SKIP_BASELINE'));

ALTER TABLE public.decision_memory_simulations
  ADD CONSTRAINT chk_dms_status
    CHECK (status IN ('queued', 'running', 'completed', 'failed'));

ALTER TABLE public.decision_memory_simulations
  ADD CONSTRAINT chk_dms_score
    CHECK (score IS NULL OR (score >= 0 AND score <= 1));

-- ── Uniqueness constraint ─────────────────────────────────────────────────────
-- Prevents duplicate jobs when a cron run and a manual invocation both see
-- used_for_learning = false on the same decision_memory row.
-- The edge function uses ignoreDuplicates=true to silently skip conflicts.
ALTER TABLE public.decision_memory_simulations
  ADD CONSTRAINT decision_memory_simulations_unique_job
  UNIQUE (decision_memory_id, simulation_type);

-- ── Additional indexes ────────────────────────────────────────────────────────

-- Per-symbol research queries ("all simulations for BTC-USD this week")
CREATE INDEX IF NOT EXISTS idx_dms_symbol
  ON public.decision_memory_simulations (user_id, symbol, created_at DESC)
  WHERE symbol IS NOT NULL;

-- Score-sorted completed sims for learning consumers
CREATE INDEX IF NOT EXISTS idx_dms_score
  ON public.decision_memory_simulations (user_id, score DESC)
  WHERE status = 'completed' AND score IS NOT NULL;

-- ── Comments ─────────────────────────────────────────────────────────────────

COMMENT ON COLUMN public.decision_memory_simulations.input_snapshot IS
  'Non-sensitive copy of the decision_memory context at job creation. '
  'Self-contained: results remain interpretable after parent row cleanup. '
  'Never contains credentials, API keys, or raw prompt text.';

COMMENT ON COLUMN public.decision_memory_simulations.score IS
  'Signal quality score (0.0–1.0). Geometric mean of setup_score × confidence. '
  'Higher = the original signal had stronger near-miss quality. '
  'NULL when status != completed.';

COMMENT ON COLUMN public.decision_memory_simulations.started_at IS
  'Timestamp when the job transitioned to status=running.';

COMMENT ON COLUMN public.decision_memory_simulations.completed_at IS
  'Timestamp when the job transitioned to status=completed or status=failed.';
