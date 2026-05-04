-- Append-only audit log of system / agent events.
CREATE TABLE public.system_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_system_events_user_created
  ON public.system_events (user_id, created_at DESC);

CREATE INDEX idx_system_events_user_type_created
  ON public.system_events (user_id, event_type, created_at DESC);

ALTER TABLE public.system_events ENABLE ROW LEVEL SECURITY;

-- Users can read their own events.
CREATE POLICY "Users can view their own system events"
ON public.system_events
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- Users can insert events for themselves (e.g. state_changed from useSystemState).
CREATE POLICY "Users can insert their own system events"
ON public.system_events
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- No UPDATE / DELETE policies → effectively append-only for clients.
-- Service role bypasses RLS and is what the edge functions use.

-- Realtime: useRealtimeSubscriptions already lists this table.
ALTER PUBLICATION supabase_realtime ADD TABLE public.system_events;
ALTER TABLE public.system_events REPLICA IDENTITY FULL;