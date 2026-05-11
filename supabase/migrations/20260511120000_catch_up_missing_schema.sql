-- ============================================================
-- CATCH-UP MIGRATION: Missing schema as of 2026-05-11
-- ============================================================
-- The live database (project klgotmhyxxtppzpbjkfu) has only
-- applied migrations through version 20260504073510.
--
-- This single idempotent migration applies everything confirmed
-- missing from the live DB. Each section is annotated with
-- the original migration version it derives from.
--
-- SKIPPED (already in live DB):
--   system_events, war_room_messages, bobby_directives,
--   agent_health, broker_health, experiments (base),
--   strategies, trades, trade_signals (base),
--   market_intelligence (base), system_state (base),
--   system_state.last_engine_snapshot
--
-- SKIPPED (cron.schedule calls — handled separately):
--   hall-tick-5m cron, process-strategy-learning-4h cron,
--   strategy_learning_cron_token vault secret + RPC
-- ============================================================


-- ============================================================
-- SECTION 1: incidents table
-- Source: 20260503150000_hall_incidents.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS public.incidents (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  incident_id              text        NOT NULL,
  severity                 text        NOT NULL CHECK (severity IN ('P1','P2','P3','P4')),
  status                   text        NOT NULL DEFAULT 'open'
                                       CHECK (status IN ('open','resolved','escalated','standing_by')),
  affected_system          text        NOT NULL,
  affected_agent           text        NOT NULL,
  detected_at              timestamptz NOT NULL DEFAULT now(),
  resolved_at              timestamptz,
  root_cause               text        NOT NULL DEFAULT '',
  symptoms                 text[]      NOT NULL DEFAULT '{}',
  evidence                 jsonb       NOT NULL DEFAULT '{}',
  actions_taken            text[]      NOT NULL DEFAULT '{}',
  recovery_result          text        NOT NULL DEFAULT '',
  user_attention_required  boolean     NOT NULL DEFAULT false,
  follow_up_recommendation text        NOT NULL DEFAULT '',
  recurrence_count         int         NOT NULL DEFAULT 1,
  related_events           jsonb       NOT NULL DEFAULT '[]',
  safe_to_trade_status     text        NOT NULL DEFAULT 'unknown'
                                       CHECK (safe_to_trade_status IN (
                                         'paper_mode_safe','live_mode_safe',
                                         'paper_mode_unsafe','live_mode_unsafe','unknown'
                                       )),
  paper_or_live_mode       text        NOT NULL DEFAULT 'paper',
  money_at_risk            boolean     NOT NULL DEFAULT false,
  hall_version             text        NOT NULL DEFAULT 'v1',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS incidents_user_detected_idx
  ON public.incidents(user_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS incidents_status_severity_idx
  ON public.incidents(status, severity);
CREATE INDEX IF NOT EXISTS incidents_affected_agent_idx
  ON public.incidents(user_id, affected_agent, detected_at DESC);

ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own incidents select" ON public.incidents;
CREATE POLICY "own incidents select" ON public.incidents FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "own incidents insert" ON public.incidents;
CREATE POLICY "own incidents insert" ON public.incidents FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own incidents update" ON public.incidents;
CREATE POLICY "own incidents update" ON public.incidents FOR UPDATE USING (auth.uid() = user_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_incidents_updated_at'
      AND tgrelid = 'public.incidents'::regclass
  ) THEN
    CREATE TRIGGER set_incidents_updated_at
      BEFORE UPDATE ON public.incidents
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END;
$$;

-- Vault token for hall cron (cron schedule itself is skipped — see separate migration)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'hall_cron_token') THEN
    PERFORM vault.create_secret(
      gen_random_uuid()::text,
      'hall_cron_token',
      'Hall infrastructure agent cron invocation token'
    );
    RAISE NOTICE 'hall_cron_token created in vault.';
  ELSE
    RAISE NOTICE 'hall_cron_token already exists — no change.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_hall_cron_token()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT decrypted_secret
  FROM   vault.decrypted_secrets
  WHERE  name = 'hall_cron_token'
  LIMIT  1;
$$;

REVOKE ALL ON FUNCTION public.get_hall_cron_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_hall_cron_token() TO service_role;


-- ============================================================
-- SECTION 2: trade_signals.replay_packet column
-- Source: 20260510000000_add_replay_packet_to_trade_signals.sql
-- ============================================================

ALTER TABLE public.trade_signals
  ADD COLUMN IF NOT EXISTS replay_packet JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_trade_signals_replay_packet
  ON public.trade_signals USING GIN (replay_packet)
  WHERE replay_packet IS NOT NULL;

COMMENT ON COLUMN public.trade_signals.replay_packet IS
  'Replayable decision packet (DecisionReplayPacket v1). '
  'Contains non-sensitive metadata: market context, doctrine snapshot, '
  'risk gate summary, AI model metadata (no credentials), and decision outcome. '
  'Written by signal-engine immediately after INSERT. '
  'Never contains raw API keys, broker credentials, or full prompt text.';


-- ============================================================
-- SECTION 3: decision_memory table
-- Source: 20260510010000_add_decision_memory.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS public.decision_memory (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol            text        NULL,
  strategy_id       uuid        NULL,
  event_type        text        NOT NULL DEFAULT 'non_trade',
  source_agent      text        NOT NULL DEFAULT 'signal_engine',
  reason_code       text        NOT NULL,
  severity          text        NOT NULL DEFAULT 'skip',
  mode              text        NOT NULL DEFAULT 'paper',
  market_regime     text        NULL,
  confidence        numeric     NULL,
  setup_score       numeric     NULL,
  replay_packet     jsonb       NULL,
  blocker_codes     text[]      NOT NULL DEFAULT '{}',
  used_for_learning boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decision_memory_user_created
  ON public.decision_memory (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_memory_reason_created
  ON public.decision_memory (reason_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_memory_symbol
  ON public.decision_memory (user_id, symbol, created_at DESC)
  WHERE symbol IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_decision_memory_unlearned
  ON public.decision_memory (user_id, used_for_learning, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_memory_replay_packet
  ON public.decision_memory USING GIN (replay_packet)
  WHERE replay_packet IS NOT NULL;

ALTER TABLE public.decision_memory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "decision_memory: owner can select" ON public.decision_memory;
CREATE POLICY "decision_memory: owner can select"
  ON public.decision_memory FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "decision_memory: owner can insert" ON public.decision_memory;
CREATE POLICY "decision_memory: owner can insert"
  ON public.decision_memory FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "decision_memory: owner can update learning flag" ON public.decision_memory;
CREATE POLICY "decision_memory: owner can update learning flag"
  ON public.decision_memory FOR UPDATE
  USING (auth.uid() = user_id);

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


-- ============================================================
-- SECTION 4: decision_memory queue-drain index
-- Source: 20260510030000_add_decision_memory_queue_drain_index.sql
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_decision_memory_queue_drain
  ON public.decision_memory (user_id, used_for_learning, created_at ASC)
  WHERE used_for_learning = false;


-- ============================================================
-- SECTION 5: decision_memory_simulations table
-- Source: 20260510020000_add_decision_memory_simulations.sql
--   + 20260510025000_extend_decision_memory_simulations.sql
--   + 20260510030000_strategy_learning_recommendations.sql (Part 1)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.decision_memory_simulations (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_memory_id          uuid        NOT NULL
                                          REFERENCES public.decision_memory(id)
                                          ON DELETE CASCADE,
  user_id                     uuid        NOT NULL
                                          REFERENCES auth.users(id)
                                          ON DELETE CASCADE,
  simulation_type             text        NOT NULL DEFAULT 'TAKEN_IF_NOT_BLOCKED',
  lookahead_window            text        NOT NULL DEFAULT '1h',
  status                      text        NOT NULL DEFAULT 'queued',
  result                      jsonb       NULL,
  failure_reason              text        NULL,
  -- Extended columns from 20260510025000_extend_decision_memory_simulations.sql
  symbol                      text        NULL,
  strategy_id                 uuid        NULL,
  input_snapshot              jsonb       NOT NULL DEFAULT '{}',
  score                       numeric     NULL,
  started_at                  timestamptz NULL,
  completed_at                timestamptz NULL,
  -- Extended column from 20260510030000_strategy_learning_recommendations.sql (Part 1)
  used_for_strategy_learning  boolean     NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- CHECK constraints (from 20260510025000) — guarded with IF NOT EXISTS for idempotency
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_dms_simulation_type'
      AND conrelid = 'public.decision_memory_simulations'::regclass
  ) THEN
    ALTER TABLE public.decision_memory_simulations
      ADD CONSTRAINT chk_dms_simulation_type
        CHECK (simulation_type IN ('TAKEN_IF_NOT_BLOCKED', 'SKIP_BASELINE'));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_dms_status'
      AND conrelid = 'public.decision_memory_simulations'::regclass
  ) THEN
    ALTER TABLE public.decision_memory_simulations
      ADD CONSTRAINT chk_dms_status
        CHECK (status IN ('queued', 'running', 'completed', 'failed'));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_dms_score'
      AND conrelid = 'public.decision_memory_simulations'::regclass
  ) THEN
    ALTER TABLE public.decision_memory_simulations
      ADD CONSTRAINT chk_dms_score
        CHECK (score IS NULL OR (score >= 0 AND score <= 1));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'decision_memory_simulations_unique_job'
      AND conrelid = 'public.decision_memory_simulations'::regclass
  ) THEN
    ALTER TABLE public.decision_memory_simulations
      ADD CONSTRAINT decision_memory_simulations_unique_job
        UNIQUE (decision_memory_id, simulation_type);
  END IF;
END;
$$;

-- updated_at trigger function
CREATE OR REPLACE FUNCTION update_dms_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_dms_updated_at'
      AND tgrelid = 'public.decision_memory_simulations'::regclass
  ) THEN
    CREATE TRIGGER trg_dms_updated_at
      BEFORE UPDATE ON public.decision_memory_simulations
      FOR EACH ROW EXECUTE FUNCTION update_dms_updated_at();
  END IF;
END;
$$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_dms_user_status
  ON public.decision_memory_simulations (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dms_decision_memory_id
  ON public.decision_memory_simulations (decision_memory_id);

CREATE INDEX IF NOT EXISTS idx_dms_result_label
  ON public.decision_memory_simulations ((result->>'result_label'), created_at DESC)
  WHERE result IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dms_learning_action
  ON public.decision_memory_simulations ((result->>'recommended_learning_action'), created_at DESC)
  WHERE result IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dms_symbol
  ON public.decision_memory_simulations (user_id, symbol, created_at DESC)
  WHERE symbol IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dms_score
  ON public.decision_memory_simulations (user_id, score DESC)
  WHERE status = 'completed' AND score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dms_strategy_learning
  ON public.decision_memory_simulations (user_id, used_for_strategy_learning, status, created_at DESC)
  WHERE result IS NOT NULL;

-- RLS
ALTER TABLE public.decision_memory_simulations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dms: owner can select" ON public.decision_memory_simulations;
CREATE POLICY "dms: owner can select"
  ON public.decision_memory_simulations FOR SELECT
  USING (auth.uid() = user_id);

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

COMMENT ON COLUMN public.decision_memory_simulations.used_for_strategy_learning IS
  'Set to true after this simulation has been grouped into a strategy_learning_recommendation. '
  'Never set to true for missing_side or insufficient_data simulations unless they contributed '
  'an INSUFFICIENT_EVIDENCE recommendation. Prevents duplicate recommendation generation.';


-- ============================================================
-- SECTION 6: strategy_learning_recommendations table
-- Source: 20260510030000_strategy_learning_recommendations.sql (Part 2)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.strategy_learning_recommendations (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid        NOT NULL
                                        REFERENCES auth.users(id)
                                        ON DELETE CASCADE,
  symbol                    text        NULL,
  strategy_id               uuid        NULL,
  market_regime             text        NULL,
  reason_code               text        NOT NULL,
  recommendation_type       text        NOT NULL,
  recommendation            text        NOT NULL,
  confidence                numeric     NOT NULL DEFAULT 0,
  evidence_count            int         NOT NULL DEFAULT 0,
  sample_quality            text        NOT NULL DEFAULT 'insufficient',
  supporting_simulation_ids uuid[]      NOT NULL DEFAULT '{}',
  status                    text        NOT NULL DEFAULT 'pending_review',
  created_at                timestamptz NOT NULL DEFAULT now(),
  reviewed_at               timestamptz NULL,
  reviewed_by               text        NULL,
  decision                  text        NULL
);

CREATE INDEX IF NOT EXISTS idx_slr_user_status
  ON public.strategy_learning_recommendations (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_slr_symbol
  ON public.strategy_learning_recommendations (user_id, symbol, created_at DESC)
  WHERE symbol IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_slr_strategy
  ON public.strategy_learning_recommendations (strategy_id, created_at DESC)
  WHERE strategy_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_slr_type
  ON public.strategy_learning_recommendations (recommendation_type, created_at DESC);

ALTER TABLE public.strategy_learning_recommendations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "slr: owner can select" ON public.strategy_learning_recommendations;
CREATE POLICY "slr: owner can select"
  ON public.strategy_learning_recommendations FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "slr: owner can update review fields" ON public.strategy_learning_recommendations;
CREATE POLICY "slr: owner can update review fields"
  ON public.strategy_learning_recommendations FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

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


-- ============================================================
-- SECTION 7: strategy_learning_cron_token vault + RPC
-- Source: 20260510040000_process_strategy_learning_cron.sql
-- NOTE: cron.schedule call is SKIPPED — handled in separate migration.
-- ============================================================

DO $$
DECLARE
  v_existing text;
  v_new      text;
BEGIN
  SELECT decrypted_secret INTO v_existing
  FROM   vault.decrypted_secrets
  WHERE  name = 'strategy_learning_cron_token'
  LIMIT  1;

  IF v_existing IS NULL THEN
    v_new := encode(extensions.gen_random_bytes(32), 'hex');
    PERFORM vault.create_secret(
      v_new,
      'strategy_learning_cron_token',
      'Cron auth token for process-strategy-learning edge function'
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_strategy_learning_cron_token()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM   vault.decrypted_secrets
  WHERE  name = 'strategy_learning_cron_token'
  LIMIT  1;
  RETURN v_token;
END;
$$;

REVOKE ALL   ON FUNCTION public.get_strategy_learning_cron_token() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_strategy_learning_cron_token() TO service_role;


-- ============================================================
-- SECTION 8: experiments.source + source_recommendation_id columns
-- Source: 20260510060000_add_experiment_source_fields.sql
-- ============================================================

ALTER TABLE public.experiments
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'user';

COMMENT ON COLUMN public.experiments.source IS
  'Origin of this experiment proposal. '
  '''user'': created manually by the operator. '
  '''copilot'': proposed by the AI copilot cron. '
  '''coach'': proposed by the coach agent. '
  '''strategy_learning'': queued from an accepted strategy learning recommendation.';

ALTER TABLE public.experiments
  ADD COLUMN IF NOT EXISTS source_recommendation_id uuid NULL
    REFERENCES public.strategy_learning_recommendations(id)
    ON DELETE SET NULL;

COMMENT ON COLUMN public.experiments.source_recommendation_id IS
  'When source = ''strategy_learning'', this is the UUID of the '
  'strategy_learning_recommendations row that was accepted and then used to '
  'create this experiment proposal. NULL for all other sources.';

CREATE INDEX IF NOT EXISTS idx_experiments_source_recommendation
  ON public.experiments (source_recommendation_id)
  WHERE source_recommendation_id IS NOT NULL;


-- ============================================================
-- SECTION 9: ai_provenance columns
-- Source: 20260510070000_add_ai_provenance_columns.sql
-- ============================================================

ALTER TABLE public.market_intelligence
  ADD COLUMN IF NOT EXISTS ai_provenance jsonb NULL;

COMMENT ON COLUMN public.market_intelligence.ai_provenance IS
  'AiProvenance record for the most recent Brain Trust run. '
  'Never contains API keys, tokens, or raw prompt text. '
  'Null when no AI run has completed for this row yet.';

ALTER TABLE public.daily_briefs
  ADD COLUMN IF NOT EXISTS ai_provenance jsonb NULL;

COMMENT ON COLUMN public.daily_briefs.ai_provenance IS
  'AiProvenance record for the AI that generated this brief. '
  'Never contains API keys, tokens, or raw prompt text.';

ALTER TABLE public.strategy_learning_recommendations
  ADD COLUMN IF NOT EXISTS ai_provenance jsonb NULL;

COMMENT ON COLUMN public.strategy_learning_recommendations.ai_provenance IS
  'Provenance for this recommendation. provider="none" because recommendations '
  'are generated deterministically from enriched simulation data — no AI model call. '
  'validationStatus="skipped" for the same reason.';


-- ============================================================
-- SECTION 10: incidents ops_review_status fields
--             + ops_incidents_timeline VIEW
--             + update_incident_ops_status RPC
-- Source: 20260511000000_ops_incident_timeline.sql
-- ============================================================

-- Extend incidents table with ops-review fields
ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS source_event_type text;

ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS affected_workflow text NOT NULL DEFAULT 'ops';

ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS trading_blocked boolean NOT NULL DEFAULT false;

ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS ops_review_status text NOT NULL DEFAULT 'detected';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'incidents_ops_review_status_check'
      AND conrelid = 'public.incidents'::regclass
  ) THEN
    ALTER TABLE public.incidents
      ADD CONSTRAINT incidents_ops_review_status_check
        CHECK (ops_review_status IN (
          'detected','diagnosed','action_taken','verified','resolved','follow_up'
        ));
  END IF;
END;
$$;

-- ops_incidents_timeline VIEW
-- Normalises Hall incidents and operational system_events into a single timeline.
CREATE OR REPLACE VIEW public.ops_incidents_timeline AS

-- Branch 1: Hall incidents
SELECT
  i.id,
  i.user_id,
  'incident'::text                              AS source,
  i.id                                          AS source_id,
  CASE i.severity
    WHEN 'P1' THEN 'critical'
    WHEN 'P2' THEN 'warning'
    ELSE            'info'
  END                                           AS severity,
  COALESCE(
    NULLIF(i.ops_review_status, 'detected'),
    CASE i.status
      WHEN 'resolved'     THEN 'resolved'
      WHEN 'standing_by'  THEN 'diagnosed'
      ELSE                     'detected'
    END
  )                                             AS ops_status,
  i.status                                      AS hall_status,
  i.source_event_type,
  i.affected_workflow,
  i.affected_agent                              AS affected_agent,
  i.affected_system                             AS affected_system,
  i.trading_blocked,
  i.money_at_risk,
  i.paper_or_live_mode                         AS mode,
  i.user_attention_required,
  i.root_cause,
  i.evidence,
  i.actions_taken,
  i.recovery_result,
  i.follow_up_recommendation,
  i.detected_at                                AS created_at,
  i.resolved_at,
  i.updated_at,
  i.incident_id                                AS human_id,
  i.symptoms                                   AS tags

FROM public.incidents i

UNION ALL

-- Branch 2: Operational system_events
SELECT
  se.id,
  se.user_id,
  'system_event'::text                          AS source,
  se.id                                         AS source_id,
  CASE se.event_type
    WHEN 'AI_GUARD_REJECTED' THEN
      CASE
        WHEN (se.payload->>'surface') IN ('trade_signal','broker_execution','jessica_decision')
          THEN 'critical'
        ELSE 'warning'
      END
    WHEN 'AI_GUARD_FALLBACK'        THEN 'info'
    WHEN 'kill_switch_on'           THEN 'critical'
    WHEN 'kill_switch_off'          THEN 'info'
    WHEN 'state_changed'            THEN
      CASE
        WHEN (se.payload->>'kill_switch_engaged') = 'true'  THEN 'critical'
        WHEN (se.payload->>'live_trading_enabled') = 'true' THEN 'warning'
        ELSE 'info'
      END
    WHEN 'bot_paused'               THEN 'warning'
    WHEN 'bot_resumed'              THEN 'info'
    WHEN 'autonomy_changed'         THEN 'info'
    ELSE                                 'info'
  END                                           AS severity,
  'detected'::text                              AS ops_status,
  'open'::text                                  AS hall_status,
  se.event_type                                 AS source_event_type,
  CASE se.event_type
    WHEN 'AI_GUARD_REJECTED'  THEN COALESCE(se.payload->>'surface', 'ops')
    WHEN 'AI_GUARD_FALLBACK'  THEN COALESCE(se.payload->>'surface', 'ops')
    WHEN 'kill_switch_on'     THEN 'trade_decision'
    WHEN 'kill_switch_off'    THEN 'trade_decision'
    WHEN 'state_changed'      THEN 'ops'
    WHEN 'bot_paused'         THEN 'ops'
    WHEN 'bot_resumed'        THEN 'ops'
    WHEN 'autonomy_changed'   THEN 'ops'
    ELSE                           'ops'
  END                                           AS affected_workflow,
  se.actor                                      AS affected_agent,
  se.event_type                                 AS affected_system,
  CASE se.event_type
    WHEN 'kill_switch_on'  THEN true
    WHEN 'AI_GUARD_REJECTED' THEN
      CASE
        WHEN (se.payload->>'surface') IN ('trade_signal','broker_execution','jessica_decision')
          THEN true
        ELSE false
      END
    WHEN 'state_changed' THEN
      CASE WHEN (se.payload->>'kill_switch_engaged') = 'true' THEN true ELSE false END
    ELSE false
  END                                           AS trading_blocked,
  false                                         AS money_at_risk,
  'unknown'::text                               AS mode,
  CASE se.event_type
    WHEN 'AI_GUARD_REJECTED' THEN
      CASE
        WHEN (se.payload->>'surface') IN ('trade_signal','broker_execution','jessica_decision')
          THEN true
        ELSE false
      END
    WHEN 'kill_switch_on' THEN true
    ELSE false
  END                                           AS user_attention_required,
  COALESCE(
    se.payload->>'sanitizedReason',
    se.payload->>'reason',
    se.event_type
  )                                             AS root_cause,
  jsonb_build_object(
    'surface',              se.payload->'surface',
    'decisionType',         se.payload->'decisionType',
    'validationStatus',     se.payload->'validationStatus',
    'unsafeIntentCount',    se.payload->'unsafeIntentCount',
    'protectedActionCount', se.payload->'protectedActionCount',
    'actor',                to_jsonb(se.actor)
  )                                             AS evidence,
  ARRAY[]::text[]                               AS actions_taken,
  ''::text                                      AS recovery_result,
  ''::text                                      AS follow_up_recommendation,
  se.created_at,
  NULL::timestamptz                             AS resolved_at,
  se.created_at                                 AS updated_at,
  'sys_' || left(se.id::text, 8)                AS human_id,
  ARRAY[se.event_type]::text[]                  AS tags

FROM public.system_events se
WHERE se.event_type IN (
  'AI_GUARD_REJECTED',
  'AI_GUARD_FALLBACK',
  'kill_switch_on',
  'kill_switch_off',
  'state_changed',
  'bot_paused',
  'bot_resumed',
  'autonomy_changed'
);

-- Grant read access to authenticated users (RLS applies to base tables)
GRANT SELECT ON public.ops_incidents_timeline TO authenticated;

-- RPC: update ops_review_status
CREATE OR REPLACE FUNCTION public.update_incident_ops_status(
  p_incident_id  uuid,
  p_ops_status   text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_ops_status NOT IN ('detected','diagnosed','action_taken','verified','resolved','follow_up') THEN
    RAISE EXCEPTION 'Invalid ops_review_status: %', p_ops_status;
  END IF;

  UPDATE public.incidents
     SET ops_review_status = p_ops_status,
         updated_at        = now(),
         resolved_at       = CASE WHEN p_ops_status = 'resolved' THEN now() ELSE resolved_at END
   WHERE id      = p_incident_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incident not found or access denied';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_incident_ops_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_incident_ops_status(uuid, text) TO authenticated;
