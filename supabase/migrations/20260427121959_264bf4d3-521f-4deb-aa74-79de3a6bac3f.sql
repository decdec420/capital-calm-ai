-- tool_calls — audit log for every action Harvey or Jessica takes.
-- actor distinguishes interactive (harvey_chat) from autonomous (jessica_autonomous).

CREATE TABLE IF NOT EXISTS public.tool_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor         text NOT NULL CHECK (actor IN ('harvey_chat', 'jessica_autonomous')),
  tool_name     text NOT NULL,
  tool_args     jsonb NOT NULL DEFAULT '{}',
  reason        text,
  result        jsonb,
  success       boolean NOT NULL DEFAULT false,
  called_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_calls_user_time_idx ON public.tool_calls(user_id, called_at DESC);

ALTER TABLE public.tool_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own tool calls"
  ON public.tool_calls FOR SELECT
  USING (auth.uid() = user_id);

-- Add approval tracking to trade_signals
ALTER TABLE public.trade_signals
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_reason text;

-- Add pause support to system_state (trading_paused_until already exists; add pause_reason)
ALTER TABLE public.system_state
  ADD COLUMN IF NOT EXISTS pause_reason text;