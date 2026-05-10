-- =============================================================================
-- PR #38 — Outcome Enrichment: decision_memory_simulations table
-- =============================================================================
-- Context:
--   decision_memory (PR #36) records non-trade decisions (vetoed, blocked,
--   skipped). This table stores the forward-price simulation results for those
--   decisions so Wendy can answer:
--
--     "If we HAD taken this blocked idea, what likely happened next?"
--     "Was the block correct?"
--     "Should we reinforce, question, or tune the threshold?"
--
-- Safety invariants:
--   - NEVER triggers broker execution.
--   - NEVER stores credentials or API keys.
--   - NEVER weakens risk gates.
--   - NEVER auto-approves signals.
--   - This table is read-only for learning consumers.
--   - status/result are written ONLY by the enrich-simulations edge function.
--
-- Simulation flow:
--   1. decision_memory row (used_for_learning = false)
--   2. enrich-simulations fetches Coinbase forward candles
--   3. Result stored here with result_label + recommended_learning_action
--   4. decision_memory.used_for_learning set to true (only on success)
-- =============================================================================

CREATE TABLE public.decision_memory_simulations (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_memory_id          uuid        NOT NULL
                                          REFERENCES public.decision_memory(id)
                                          ON DELETE CASCADE,
  user_id                     uuid        NOT NULL
                                          REFERENCES auth.users(id)
                                          ON DELETE CASCADE,

  -- What counterfactual scenario is being simulated.
  -- TAKEN_IF_NOT_BLOCKED = "what if the signal had been executed?"
  simulation_type             text        NOT NULL DEFAULT 'TAKEN_IF_NOT_BLOCKED',

  -- How far forward we looked for price data.
  -- '15m' | '1h' | '4h'
  lookahead_window            text        NOT NULL DEFAULT '1h',

  -- Lifecycle: queued → running → completed | failed
  status                      text        NOT NULL DEFAULT 'queued',

  -- Structured result JSONB — see SimulationResult type in outcome-enrichment.ts.
  -- Null while status = 'queued' or 'running'.
  -- Contains: result_label, simulated_entry_price, simulated_exit_price,
  --           hypothetical_pnl, hypothetical_return_pct,
  --           max_adverse_excursion, max_favorable_excursion,
  --           recommended_learning_action, enriched_at,
  --           insufficient_data_reason.
  result                      jsonb       NULL,

  -- Human-readable failure reason when status = 'failed'.
  failure_reason              text        NULL,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary enrichment queue: unprocessed simulations per user
CREATE INDEX idx_dms_user_status
  ON public.decision_memory_simulations (user_id, status, created_at DESC);

-- Join from parent decision_memory row
CREATE INDEX idx_dms_decision_memory_id
  ON public.decision_memory_simulations (decision_memory_id);

-- Result label queries: "how many would_have_won blocks in the last 7 days?"
CREATE INDEX idx_dms_result_label
  ON public.decision_memory_simulations ((result->>'result_label'), created_at DESC)
  WHERE result IS NOT NULL;

-- Learning action queries: "all question_block recommendations"
CREATE INDEX idx_dms_learning_action
  ON public.decision_memory_simulations ((result->>'recommended_learning_action'), created_at DESC)
  WHERE result IS NOT NULL;

-- ── updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_dms_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_dms_updated_at
  BEFORE UPDATE ON public.decision_memory_simulations
  FOR EACH ROW EXECUTE FUNCTION update_dms_updated_at();

-- ── Row-Level Security ────────────────────────────────────────────────────────
ALTER TABLE public.decision_memory_simulations ENABLE ROW LEVEL SECURITY;

-- Users can read their own simulation results
CREATE POLICY "dms: owner can select"
  ON public.decision_memory_simulations FOR SELECT
  USING (auth.uid() = user_id);

-- Service role (enrich-simulations) bypasses RLS — no INSERT policy needed
-- for browser users since simulations are created server-side only.

-- ── Comments ──────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.decision_memory_simulations IS
  'Forward-price simulation results for non-trade decisions stored in '
  'decision_memory. Answers "if we had taken this blocked signal, what '
  'likely happened next?" Used by Wendy for learning classification. '
  'Never triggers execution. Written exclusively by enrich-simulations.';

COMMENT ON COLUMN public.decision_memory_simulations.simulation_type IS
  'TAKEN_IF_NOT_BLOCKED: counterfactual "what if we executed this blocked signal?"';

COMMENT ON COLUMN public.decision_memory_simulations.result IS
  'SimulationResult JSONB. Fields: result_label (would_have_won | '
  'would_have_lost | no_clear_edge | insufficient_data), '
  'simulated_entry_price, simulated_exit_price, hypothetical_pnl, '
  'hypothetical_return_pct, max_adverse_excursion, max_favorable_excursion, '
  'recommended_learning_action (reinforce_block | question_block | '
  'tune_threshold | ignore_insufficient_data), enriched_at, '
  'insufficient_data_reason.';

COMMENT ON COLUMN public.decision_memory_simulations.lookahead_window IS
  'How far forward the enrichment looked for price data. '
  '''15m'' = 15 minutes, ''1h'' = 1 hour, ''4h'' = 4 hours.';
