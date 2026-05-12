
-- Add ai_provenance column to market_intelligence (was missing, blocking every upsert)
ALTER TABLE public.market_intelligence
  ADD COLUMN IF NOT EXISTS ai_provenance jsonb;

-- Create decision_memory table for non-trade decisions (was missing, blocking signal-engine writes)
CREATE TABLE IF NOT EXISTS public.decision_memory (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol          text,
  strategy_id     uuid,
  event_type      text NOT NULL DEFAULT 'non_trade',
  source_agent    text NOT NULL DEFAULT 'signal_engine',
  reason_code     text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('halt','block','skip','warn')),
  mode            text NOT NULL CHECK (mode IN ('paper','live','research')),
  market_regime   text,
  confidence      numeric,
  setup_score     numeric,
  replay_packet   jsonb,
  blocker_codes   text[] NOT NULL DEFAULT '{}',
  used_for_learning boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decision_memory_user_created
  ON public.decision_memory (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_memory_user_symbol
  ON public.decision_memory (user_id, symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_memory_user_reason
  ON public.decision_memory (user_id, reason_code, created_at DESC);

ALTER TABLE public.decision_memory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own decision_memory select" ON public.decision_memory;
CREATE POLICY "own decision_memory select"
  ON public.decision_memory FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policy for authenticated users:
-- service_role (used by edge functions) bypasses RLS; clients are read-only.
