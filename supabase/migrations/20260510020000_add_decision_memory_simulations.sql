-- =============================================================================
-- PR #37 — Batch Simulation Queue: decision_memory_simulations table
-- =============================================================================
-- Context: decision_memory (PR #36) stores non-trade decisions as an input
-- queue for research. One decision_memory row can spawn multiple simulation
-- variants (e.g., TAKEN_IF_NOT_BLOCKED and SKIP_BASELINE), so a child table
-- is required rather than adding columns to decision_memory.
--
-- Storage target rationale:
--   experiments: wrong shape — parameter A/B testing (before_value/after_value),
--     not per-event counterfactual scoring. Reusing it would cause schema
--     confusion and requires a strategy_id + parameter pair that blocked
--     signals often lack.
--   decision_memory: append-only input; result fields would create a 1:many
--     mismatch if multiple sim types run per memory row.
--   This table: child of decision_memory, one row per (memory_id, sim_type).
--     One blocked signal → TAKEN_IF_NOT_BLOCKED + SKIP_BASELINE = 2 rows.
--     Clean separation: inputs stay in decision_memory, outputs live here.
--
-- Safety invariants:
--   - NEVER stores broker credentials, API keys, or auth headers.
--   - NEVER triggers broker execution or creates trade rows.
--   - NEVER modifies doctrine or risk gate state.
--   - Append-only results; status transitions: queued→running→completed|failed.
--   - Simulation results are scoring/labeling only — no order IDs, no fills.
-- =============================================================================

CREATE TABLE public.decision_memory_simulations (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Parent decision memory row (foreign key, CASCADE on delete)
  decision_memory_id   uuid        NOT NULL REFERENCES public.decision_memory(id) ON DELETE CASCADE,

  -- Denormalized for fast per-user queries without joining decision_memory
  user_id              uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Symbol from the original decision (nullable: account-level halts have no symbol)
  symbol               text        NULL,

  -- Strategy in scope at decision time (nullable: may be absent for some blocks)
  strategy_id          uuid        NULL,

  -- Simulation type: which counterfactual scenario was modeled
  -- Valid values: TAKEN_IF_NOT_BLOCKED | SKIP_BASELINE
  simulation_type      text        NOT NULL
    CHECK (simulation_type IN ('TAKEN_IF_NOT_BLOCKED', 'SKIP_BASELINE')),

  -- Job lifecycle status
  status               text        NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  -- Valid values: queued | running | completed | failed

  -- Non-sensitive snapshot of the inputs used to run this simulation.
  -- Copied from decision_memory at job creation time so results are
  -- self-contained even if the parent row is later cleaned up.
  input_snapshot       jsonb       NOT NULL DEFAULT '{}',

  -- Simulation output — NULL until status = 'completed'.
  -- Contains SimulationResult fields (see simulation-engine.ts).
  -- Never contains broker credentials, trade IDs, or execution instructions.
  result               jsonb       NULL,

  -- Summary score (0.0–1.0) derived from result, for easy sorting/filtering.
  -- NULL until completed.
  score                numeric     NULL
    CHECK (score IS NULL OR (score >= 0 AND score <= 1)),

  -- Error message if status = 'failed'; NULL otherwise.
  error                text        NULL,

  -- Lifecycle timestamps
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz NULL,
  completed_at         timestamptz NULL
);

-- ── Uniqueness constraint — prevents duplicate jobs from concurrent drains ────
-- Two simultaneous invocations (cron + manual) both see used_for_learning=false
-- and would insert the same (decision_memory_id, simulation_type) pair.
-- This constraint makes the second insert a no-op (handled with ON CONFLICT
-- DO NOTHING in the edge function) rather than silently creating duplicates.
ALTER TABLE public.decision_memory_simulations
  ADD CONSTRAINT decision_memory_simulations_unique_job
  UNIQUE (decision_memory_id, simulation_type);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary drain query: per-user queued jobs oldest-first
CREATE INDEX idx_decision_memory_sim_user_status
  ON public.decision_memory_simulations (user_id, status, created_at ASC);

-- Parent join: "all simulations for a given memory row"
CREATE INDEX idx_decision_memory_sim_parent
  ON public.decision_memory_simulations (decision_memory_id);

-- Per-symbol research: "what simulations have we run on BTC-USD?"
CREATE INDEX idx_decision_memory_sim_symbol
  ON public.decision_memory_simulations (user_id, symbol, created_at DESC)
  WHERE symbol IS NOT NULL;

-- Score browsing: highest-scored completed sims for a user
CREATE INDEX idx_decision_memory_sim_score
  ON public.decision_memory_simulations (user_id, score DESC)
  WHERE status = 'completed' AND score IS NOT NULL;

-- ── Row-Level Security ────────────────────────────────────────────────────────
ALTER TABLE public.decision_memory_simulations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "decision_memory_simulations: owner can select"
  ON public.decision_memory_simulations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "decision_memory_simulations: owner can insert"
  ON public.decision_memory_simulations FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.decision_memory
      WHERE id = decision_memory_id
        AND user_id = auth.uid()
    )
  );

-- NOTE: No UPDATE policy for authenticated users.
-- All lifecycle writes (queued→running→completed|failed) are performed by the
-- process-decision-memory edge function using the service-role client, which
-- bypasses RLS entirely. Granting UPDATE to authenticated users would allow
-- them to overwrite status, result, score, or error fields directly via the
-- public Supabase client, corrupting the research audit trail.
-- NO UPDATE policy — service role handles all writes.

-- NO DELETE policy — simulation results are permanent for audit and research
-- integrity. Old rows can be archived but never silently dropped.

-- ── Comments ──────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.decision_memory_simulations IS
  'Child table of decision_memory. Each row is one simulation job derived from '
  'a non-trade decision. Supports multiple variants per source event '
  '(e.g., TAKEN_IF_NOT_BLOCKED + SKIP_BASELINE for the same blocked signal). '
  'Results are scoring/labeling only — never contains broker credentials, '
  'order IDs, or execution triggers.';

COMMENT ON COLUMN public.decision_memory_simulations.simulation_type IS
  'Which counterfactual scenario was modeled. '
  'TAKEN_IF_NOT_BLOCKED: score the signal as if the block had not fired. '
  'SKIP_BASELINE: confirm the skip was the correct decision.';

COMMENT ON COLUMN public.decision_memory_simulations.input_snapshot IS
  'Non-sensitive copy of the decision_memory context used as simulation input. '
  'Self-contained so results remain interpretable after parent row cleanup. '
  'Never includes broker credentials, API keys, or raw prompt text.';

COMMENT ON COLUMN public.decision_memory_simulations.result IS
  'SimulationResult JSONB. Contains: would_have_entered, result_label, '
  'recommended_learning_action, score, scored_at, and null price fields '
  '(set to insufficient_data when forward price data is unavailable). '
  'Never contains trade IDs, broker order IDs, or execution fields.';

COMMENT ON COLUMN public.decision_memory_simulations.score IS
  'Summary quality score (0.0–1.0). Derived from setup_score × confidence '
  '(geometric mean). Higher = the original signal had stronger near-miss quality. '
  'NULL when status != completed.';
