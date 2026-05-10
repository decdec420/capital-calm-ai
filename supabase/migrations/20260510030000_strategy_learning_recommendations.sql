-- =============================================================================
-- PR #39 — Strategy Learning Consumer
-- =============================================================================
-- Part 1: Add used_for_strategy_learning to decision_memory_simulations
-- Part 2: Create strategy_learning_recommendations table
--
-- Context:
--   decision_memory (PR #36) records non-trade decisions.
--   decision_memory_simulations (PR #38) stores forward-price outcomes.
--   This migration closes the loop: simulations are consumed into
--   reviewable, proposal-only strategy learning recommendations.
--
-- Safety invariants — this schema NEVER:
--   - Triggers broker execution.
--   - Stores credentials or API keys.
--   - Auto-mutates strategies, doctrine, or risk gates.
--   - Enables live trading.
--   - Auto-approves signals.
--   - Weakens safety blocks.
--
-- The recommendation lifecycle is:
--   1. process-strategy-learning groups enriched simulations
--   2. Creates a recommendation row with status = 'pending_review'
--   3. A human (or future review agent) inspects and sets status to
--      'accepted' | 'rejected' | 'deferred'
--   4. Only then can any downstream action be considered
-- =============================================================================

-- ── Part 1: Mark simulations consumed by strategy learning ───────────────────
ALTER TABLE public.decision_memory_simulations
  ADD COLUMN IF NOT EXISTS used_for_strategy_learning boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.decision_memory_simulations.used_for_strategy_learning IS
  'Set to true after this simulation has been grouped into a strategy_learning_recommendation. '
  'Never set to true for missing_side or insufficient_data simulations unless they contributed '
  'an INSUFFICIENT_EVIDENCE recommendation. Prevents duplicate recommendation generation.';

-- Index for the consumer: find unconsumed completed simulations efficiently
CREATE INDEX IF NOT EXISTS idx_dms_strategy_learning
  ON public.decision_memory_simulations (user_id, used_for_strategy_learning, status, created_at DESC)
  WHERE result IS NOT NULL;

-- ── Part 2: strategy_learning_recommendations table ──────────────────────────
CREATE TABLE public.strategy_learning_recommendations (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     uuid        NOT NULL
                                          REFERENCES auth.users(id)
                                          ON DELETE CASCADE,

  -- What was the learning opportunity scoped to?
  symbol                      text        NULL,      -- null = account-level pattern
  strategy_id                 uuid        NULL,      -- null = no strategy identified
  market_regime               text        NULL,      -- null = not regime-specific

  -- What kind of pattern was detected?
  -- Maps to NonTradeReasonCode from decision_memory
  reason_code                 text        NOT NULL,

  -- What the consumer recommends doing.
  -- One of: REINFORCE_BLOCKER | QUESTION_BLOCKER | TUNE_THRESHOLD |
  --         REVIEW_STRATEGY_FIT | INSUFFICIENT_EVIDENCE
  recommendation_type         text        NOT NULL,

  -- Human-readable recommendation text for the review UI.
  recommendation              text        NOT NULL,

  -- Statistical confidence of this recommendation (0.0–1.0).
  -- Conservative: requires strong, consistent evidence.
  confidence                  numeric     NOT NULL DEFAULT 0,

  -- How many simulations contributed to this recommendation.
  evidence_count              int         NOT NULL DEFAULT 0,

  -- Quality classification of the evidence pool.
  -- 'insufficient' | 'weak' | 'moderate' | 'strong'
  sample_quality              text        NOT NULL DEFAULT 'insufficient',

  -- UUIDs of the decision_memory_simulations rows that contributed.
  supporting_simulation_ids   uuid[]      NOT NULL DEFAULT '{}',

  -- Lifecycle: pending_review → accepted | rejected | deferred
  status                      text        NOT NULL DEFAULT 'pending_review',

  created_at                  timestamptz NOT NULL DEFAULT now(),
  reviewed_at                 timestamptz NULL,
  reviewed_by                 text        NULL,      -- user email or system label
  decision                    text        NULL       -- free-text rationale from reviewer
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Dashboard: pending recommendations per user, newest first
CREATE INDEX idx_slr_user_status
  ON public.strategy_learning_recommendations (user_id, status, created_at DESC);

-- Symbol-specific queries
CREATE INDEX idx_slr_symbol
  ON public.strategy_learning_recommendations (user_id, symbol, created_at DESC)
  WHERE symbol IS NOT NULL;

-- Strategy-specific queries
CREATE INDEX idx_slr_strategy
  ON public.strategy_learning_recommendations (strategy_id, created_at DESC)
  WHERE strategy_id IS NOT NULL;

-- Recommendation type filtering
CREATE INDEX idx_slr_type
  ON public.strategy_learning_recommendations (recommendation_type, created_at DESC);

-- ── Row-Level Security ────────────────────────────────────────────────────────
ALTER TABLE public.strategy_learning_recommendations ENABLE ROW LEVEL SECURITY;

-- Users can read their own recommendations
CREATE POLICY "slr: owner can select"
  ON public.strategy_learning_recommendations FOR SELECT
  USING (auth.uid() = user_id);

-- Users can update status/reviewed_at/reviewed_by/decision (review workflow)
CREATE POLICY "slr: owner can update review fields"
  ON public.strategy_learning_recommendations FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Service role (process-strategy-learning) bypasses RLS for INSERT —
-- no browser INSERT policy needed since recommendations are generated server-side.

-- ── Comments ──────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.strategy_learning_recommendations IS
  'Proposal-only strategy learning recommendations generated by process-strategy-learning. '
  'Each row represents a pattern detected across multiple enriched simulation outcomes. '
  'Recommendations are NEVER auto-applied. A human must review and accept/reject each one. '
  'Does not trigger execution. Does not alter strategies, doctrine, or risk gates.';

COMMENT ON COLUMN public.strategy_learning_recommendations.recommendation_type IS
  'REINFORCE_BLOCKER: evidence confirms this block is correct. '
  'QUESTION_BLOCKER: evidence suggests this block may deserve review. '
  'TUNE_THRESHOLD: threshold-based block (e.g. confidence) shows consistent missed wins. '
  'REVIEW_STRATEGY_FIT: symbol+regime+strategy combination needs attention. '
  'INSUFFICIENT_EVIDENCE: pattern noticed but sample too small to act on.';

COMMENT ON COLUMN public.strategy_learning_recommendations.confidence IS
  'Conservative statistical confidence (0–1). '
  'Requires minimum 5 samples for any recommendation. '
  'Requires minimum 0.65 confidence for actionable types. '
  'INSUFFICIENT_EVIDENCE recommendations always have confidence < 0.65.';

COMMENT ON COLUMN public.strategy_learning_recommendations.sample_quality IS
  'insufficient: < 5 samples. weak: 5–9. moderate: 10–19. strong: ≥ 20.';

COMMENT ON COLUMN public.strategy_learning_recommendations.status IS
  'pending_review: waiting for human review. '
  'accepted: reviewer approved. '
  'rejected: reviewer dismissed. '
  'deferred: reviewer postponed.';
