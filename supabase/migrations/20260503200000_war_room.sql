-- ============================================================
-- War Room: agent communication layer for Axe Capital desk.
-- ─────────────────────────────────────────────────────────────
-- war_room_messages: all agents post here; Bobby reads every tick.
-- bobby_directives:  Bobby's standing orders to agents (persists across ticks).
-- ============================================================

-- ── war_room_messages ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.war_room_messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_agent      TEXT        NOT NULL,  -- 'hall' | 'dollar_bill' | 'mafee' | 'wendy' | 'spyros' | 'taylor' | 'chuck' | 'bobby'
  to_agent        TEXT        NOT NULL DEFAULT 'bobby', -- 'bobby' | 'all' | specific agent name
  message_type    TEXT        NOT NULL,  -- 'intel' | 'coaching' | 'review' | 'directive' | 'alert' | 'acknowledgment'
  subject         TEXT        NOT NULL,  -- one-line headline (~120 chars)
  body            TEXT        NOT NULL,  -- full message text
  priority        TEXT        NOT NULL DEFAULT 'normal', -- 'urgent' | 'high' | 'normal' | 'low'
  symbol          TEXT        NULL,      -- if symbol-specific (e.g. 'BTC-USD')
  read_by_bobby   BOOLEAN     NOT NULL DEFAULT FALSE,
  acted_on        BOOLEAN     NOT NULL DEFAULT FALSE,
  action_taken    TEXT        NULL,      -- what Bobby did (filled by jessica)
  metadata        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '48 hours'
);

-- Indexes for Bobby's tick query: unread messages addressed to him, not yet expired
CREATE INDEX IF NOT EXISTS idx_war_room_bobby_unread
  ON public.war_room_messages (user_id, read_by_bobby, to_agent, expires_at);

-- Index for cleaning up expired messages
CREATE INDEX IF NOT EXISTS idx_war_room_expires
  ON public.war_room_messages (expires_at);

-- RLS
ALTER TABLE public.war_room_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own war_room_messages"
  ON public.war_room_messages FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role manages war_room_messages"
  ON public.war_room_messages FOR ALL
  TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ── bobby_directives ─────────────────────────────────────────────
-- Bobby's persistent standing orders. Written by jessica, read by all agents.
-- Agents check active directives from Bobby at the start of each run.
CREATE TABLE IF NOT EXISTS public.bobby_directives (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_agent    TEXT        NOT NULL,  -- 'all' | 'hall' | 'dollar_bill' | 'mafee' | 'wendy' | 'spyros' | 'taylor'
  directive       TEXT        NOT NULL,  -- the standing order in plain English
  reason          TEXT        NULL,      -- why Bobby issued this
  priority        TEXT        NOT NULL DEFAULT 'normal',
  status          TEXT        NOT NULL DEFAULT 'active', -- 'active' | 'completed' | 'cancelled'
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NULL,      -- NULL = indefinite
  completed_at    TIMESTAMPTZ NULL
);

-- Constraint
ALTER TABLE public.bobby_directives
  ADD CONSTRAINT bobby_directives_status_chk
  CHECK (status IN ('active', 'completed', 'cancelled'));

ALTER TABLE public.bobby_directives
  ADD CONSTRAINT bobby_directives_priority_chk
  CHECK (priority IN ('urgent', 'high', 'normal', 'low'));

-- Index for agents reading their active directives
CREATE INDEX IF NOT EXISTS idx_bobby_directives_active
  ON public.bobby_directives (user_id, status, target_agent);

-- RLS
ALTER TABLE public.bobby_directives ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own bobby_directives"
  ON public.bobby_directives FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role manages bobby_directives"
  ON public.bobby_directives FOR ALL
  TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ── Comments ──────────────────────────────────────────────────────
COMMENT ON TABLE public.war_room_messages IS
  'Axe Capital War Room — agent-to-agent communication channel. '
  'All agents (Hall, Dollar Bill, Mafee, Wendy, Spyros, Taylor, Chuck) post here. '
  'Bobby reads unread messages at the start of every jessica tick and acts accordingly.';

COMMENT ON TABLE public.bobby_directives IS
  'Bobby''s standing orders to desk agents. Persist across ticks. '
  'Agents read active directives at run start and adjust behaviour accordingly. '
  'Bobby writes these via the issue_directive tool in jessica.';
