-- =============================================================================
-- PR #36 — Negative Example Memory: decision_memory table
-- =============================================================================
-- Context: The system previously had NO structured storage for decisions that
-- did NOT become trades. Vetoed/skipped signals returned early before INSERT,
-- leaving no queryable record.
--
-- This table stores lightweight, replayable negative examples so Wendy,
-- Strategy Lab, Bobby/Wags, and future research jobs can learn from what
-- was avoided.
--
-- Safety invariants:
--   - NEVER stores broker credentials, API keys, or auth headers.
--   - NEVER triggers execution.
--   - NEVER weakens risk gates.
--   - Append-only: no UPDATE policy for rows (only used_for_learning flag).
--   - replay_packet stores non-sensitive metadata only (same rules as
--     trade_signals.replay_packet).
--
-- Storage target rationale:
--   trade_signals is only for decisions that became pending proposals.
--   journal_entries is narrative text, not queryable by reason_code.
--   system_events is an audit log for operator actions.
--   This table is purpose-built for structured learning queries:
--     SELECT * FROM decision_memory WHERE reason_code = 'COACH_PENALTY'
--     SELECT * FROM decision_memory WHERE symbol = 'BTC-USD' AND used_for_learning = false
-- =============================================================================

CREATE TABLE public.decision_memory (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol             text        NULL,
  strategy_id        uuid        NULL,
  event_type         text        NOT NULL DEFAULT 'non_trade',
  source_agent       text        NOT NULL DEFAULT 'signal_engine',

  -- Canonical reason code — see COMMENT below for valid values.
  reason_code        text        NOT NULL,

  -- Severity mirrors GateSeverity: halt | block | skip | warn
  severity           text        NOT NULL DEFAULT 'skip',

  -- Trading mode at decision time
  mode               text        NOT NULL DEFAULT 'paper',

  -- Market context at decision time (non-sensitive summaries)
  market_regime      text        NULL,
  confidence         numeric     NULL,
  setup_score        numeric     NULL,

  -- Non-sensitive replay snapshot (same security rules as replay_packet in trade_signals)
  replay_packet      jsonb       NULL,

  -- All gate/reason codes that contributed to this block (for fast filtering)
  blocker_codes      text[]      NOT NULL DEFAULT '{}',

  -- Set to true by Wendy/Strategy Lab after this record is processed for learning
  used_for_learning  boolean     NOT NULL DEFAULT false,

  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary learning query: unprocessed records for a user, newest first
CREATE INDEX idx_decision_memory_user_created
  ON public.decision_memory (user_id, created_at DESC);

-- Filter by reason code across all users (research / batch jobs)
CREATE INDEX idx_decision_memory_reason_created
  ON public.decision_memory (reason_code, created_at DESC);

-- Per-symbol learning: "what did we avoid on BTC-USD this week?"
CREATE INDEX idx_decision_memory_symbol
  ON public.decision_memory (user_id, symbol, created_at DESC)
  WHERE symbol IS NOT NULL;

-- Incremental learning queue: WHERE used_for_learning = false
CREATE INDEX idx_decision_memory_unlearned
  ON public.decision_memory (user_id, used_for_learning, created_at DESC);

-- GIN index for replay_packet JSONB queries
CREATE INDEX idx_decision_memory_replay_packet
  ON public.decision_memory USING GIN (replay_packet)
  WHERE replay_packet IS NOT NULL;

-- ── Row-Level Security ────────────────────────────────────────────────────────
ALTER TABLE public.decision_memory ENABLE ROW LEVEL SECURITY;

-- Owning user can read their own records
CREATE POLICY "decision_memory: owner can select"
  ON public.decision_memory FOR SELECT
  USING (auth.uid() = user_id);

-- Owning user can insert (UI paths; service role bypasses RLS anyway)
CREATE POLICY "decision_memory: owner can insert"
  ON public.decision_memory FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Only allow updating the used_for_learning flag (Wendy/Strategy Lab marking processed)
CREATE POLICY "decision_memory: owner can update learning flag"
  ON public.decision_memory FOR UPDATE
  USING (auth.uid() = user_id);

-- NO DELETE policy — records are permanent for audit and learning integrity.

-- ── Comments ──────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.decision_memory IS
  'Structured memory of non-trade decisions (skipped, vetoed, blocked). '
  'Used by Wendy, Strategy Lab, and future research jobs to learn from avoided trades. '
  'Append-only. Never contains broker credentials or execution triggers. '
  'Written by signal-engine (service role) at every non-trade early-return path.';

COMMENT ON COLUMN public.decision_memory.reason_code IS
  'Canonical non-trade reason code. Valid values: '
  'NO_TRADE_REGIME | LOW_SETUP_SCORE | LOW_CONFIDENCE | COACH_PENALTY | '
  'EDGE_BELOW_COSTS | AI_ERROR | RISK_GATE_BLOCK | KILL_SWITCH_ACTIVE | '
  'DAILY_LOSS_CAP_REACHED | ACCOUNT_FLOOR_BREACHED | MAX_TRADES_REACHED | '
  'COOLDOWN_ACTIVE | DOCTRINE_BLOCK | BRAIN_TRUST_STALE | MARKET_DATA_STALE | '
  'NO_APPROVED_STRATEGY | RISK_MANAGER_VETO | RISK_MANAGER_SKIP_TICK | OPERATOR_REJECTED';

COMMENT ON COLUMN public.decision_memory.replay_packet IS
  'Non-sensitive snapshot of market context, doctrine caps, and gate reasons at '
  'decision time. Same security rules as trade_signals.replay_packet: '
  'never includes credentials, raw API keys, or full prompt text.';

COMMENT ON COLUMN public.decision_memory.used_for_learning IS
  'Set to true by Wendy/Strategy Lab when this record has been processed for '
  'learning. Enables incremental queries: WHERE used_for_learning = false ORDER BY created_at.';

COMMENT ON COLUMN public.decision_memory.blocker_codes IS
  'Array of all gate/reason codes that contributed to the block. '
  'Allows fast filtering: WHERE ''KILL_SWITCH'' = ANY(blocker_codes).';
