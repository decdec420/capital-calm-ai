-- ============================================================
-- system_events — immutable operator/autonomous action audit trail (MED-6)
-- ============================================================
-- Captures every state-changing action that affects live-trading
-- risk posture: kill-switch toggles, autonomy changes, live mode
-- flips, and bot pause/resume. Append-only; UPDATE and DELETE are
-- blocked at the RLS level so the log cannot be retroactively edited.
--
-- Populated by:
--   • supabase/functions/_shared/desk-tools.ts  (Jessica autonomous actions)
--   • src/hooks/useSystemState.ts               (operator UI actions)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.system_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  event_type  text NOT NULL,      -- e.g. 'kill_switch_on', 'autonomy_changed', 'bot_paused'
  actor       text NOT NULL,      -- 'operator' | 'jessica_autonomous' | 'system'
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Index for per-user chronological reads (operator event history page)
CREATE INDEX IF NOT EXISTS idx_system_events_user_created
  ON public.system_events (user_id, created_at DESC);

-- RLS ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.system_events ENABLE ROW LEVEL SECURITY;

-- Owning user can read their own events
CREATE POLICY "system_events: owner can select"
  ON public.system_events FOR SELECT
  USING (auth.uid() = user_id);

-- Owning user can insert (operator UI path)
CREATE POLICY "system_events: owner can insert"
  ON public.system_events FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Service-role can insert (Jessica / edge function path — bypasses RLS anyway)

-- NO UPDATE, NO DELETE policies — log is append-only.

COMMENT ON TABLE public.system_events IS
  'Immutable audit trail of operator and autonomous agent state-change actions. '
  'Append-only — no UPDATE or DELETE policies exist. '
  'See desk-tools.ts and useSystemState.ts for write paths.';
