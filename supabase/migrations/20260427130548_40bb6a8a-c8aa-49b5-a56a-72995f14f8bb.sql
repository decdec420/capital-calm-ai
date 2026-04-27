-- ─── agent_health table ──────────────────────────────────────────────────
-- Tracks per-agent health status. Written by Jessica (every tick) and by
-- the check_jessica_heartbeat() scheduled function. Read by Harvey and the UI.
-- Note: no FK to auth.users per project convention; RLS uses auth.uid().

CREATE TABLE IF NOT EXISTS public.agent_health (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  agent_name    text NOT NULL,
  status        text NOT NULL CHECK (status IN ('healthy', 'degraded', 'failed', 'stale')),
  last_success  timestamptz,
  last_failure  timestamptz,
  failure_count int NOT NULL DEFAULT 0,
  last_error    text,
  checked_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_health_user_agent_idx
  ON public.agent_health(user_id, agent_name);

ALTER TABLE public.agent_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own agent health"
  ON public.agent_health FOR SELECT
  USING (auth.uid() = user_id);

-- ─── Jessica heartbeat watchdog (Option C) ───────────────────────────────
-- Runs every 3 minutes via pg_cron. Pure SQL, no edge runtime dependency.
-- If Jessica's last decision is older than 4 minutes (or null), flag her
-- as failed and raise a deduplicated critical alert.

CREATE OR REPLACE FUNCTION public.check_jessica_heartbeat()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row         RECORD;
  v_ran_at      timestamptz;
  v_age_minutes int;
  v_status      text;
  v_error       text;
BEGIN
  FOR v_row IN
    SELECT user_id, last_jessica_decision
    FROM public.system_state
    WHERE user_id IS NOT NULL
  LOOP
    -- Pull ran_at from the JSONB blob Jessica writes each tick.
    v_ran_at := NULLIF(v_row.last_jessica_decision->>'ran_at', '')::timestamptz;

    IF v_ran_at IS NULL THEN
      v_age_minutes := 9999;
      v_status      := 'failed';
      v_error       := 'Jessica has never recorded a decision — cron may not be running.';
    ELSE
      v_age_minutes := EXTRACT(EPOCH FROM (now() - v_ran_at))::int / 60;
      IF v_age_minutes > 4 THEN
        v_status := 'failed';
        v_error  := format('Jessica has not ticked in %s minutes — cron may be down.', v_age_minutes);
      ELSE
        v_status := 'healthy';
        v_error  := NULL;
      END IF;
    END IF;

    -- Upsert agent_health row for jessica_heartbeat
    INSERT INTO public.agent_health (
      user_id, agent_name, status, last_success, last_failure,
      failure_count, last_error, checked_at
    ) VALUES (
      v_row.user_id,
      'jessica_heartbeat',
      v_status,
      CASE WHEN v_status = 'healthy' THEN now() ELSE NULL END,
      CASE WHEN v_status = 'failed'  THEN now() ELSE NULL END,
      CASE WHEN v_status = 'failed'  THEN 1 ELSE 0 END,
      v_error,
      now()
    )
    ON CONFLICT (user_id, agent_name) DO UPDATE SET
      status        = EXCLUDED.status,
      last_success  = COALESCE(EXCLUDED.last_success,  agent_health.last_success),
      last_failure  = COALESCE(EXCLUDED.last_failure,  agent_health.last_failure),
      failure_count = CASE
                        WHEN EXCLUDED.status = 'failed'
                          THEN agent_health.failure_count + 1
                        ELSE 0
                      END,
      last_error    = EXCLUDED.last_error,
      checked_at    = EXCLUDED.checked_at;

    -- If failed, raise an alert — but dedupe to once per 30 minutes per user.
    IF v_status = 'failed' THEN
      INSERT INTO public.alerts (user_id, severity, title, message)
      SELECT
        v_row.user_id,
        'critical',
        'Jessica heartbeat lost',
        COALESCE(v_error, 'Jessica is not ticking.')
      WHERE NOT EXISTS (
        SELECT 1 FROM public.alerts
        WHERE user_id = v_row.user_id
          AND title = 'Jessica heartbeat lost'
          AND created_at > now() - interval '30 minutes'
      );
    END IF;
  END LOOP;
END;
$$;

-- Schedule the heartbeat check every 3 minutes.
-- Unschedule first if it already exists, then re-schedule (idempotent).
DO $$
BEGIN
  PERFORM cron.unschedule('jessica-heartbeat')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'jessica-heartbeat');
EXCEPTION WHEN OTHERS THEN
  -- ignore if cron schema/table not yet loaded in this transaction
  NULL;
END $$;

SELECT cron.schedule(
  'jessica-heartbeat',
  '*/3 * * * *',
  $cron$ SELECT public.check_jessica_heartbeat(); $cron$
);