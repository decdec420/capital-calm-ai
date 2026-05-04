-- ============================================================
-- Hall — Infrastructure Operator / Reliability Chief
-- ------------------------------------------------------------
-- Creates the incidents table, vault token, and cron schedule
-- for Hall's 5-minute monitoring tick.
-- ============================================================

-- ── incidents table ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.incidents (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  incident_id             text        NOT NULL,                -- human-readable: hall_YYYYMMDD_HHMM_slug
  severity                text        NOT NULL CHECK (severity IN ('P1','P2','P3','P4')),
  status                  text        NOT NULL DEFAULT 'open'
                                      CHECK (status IN ('open','resolved','escalated','standing_by')),
  affected_system         text        NOT NULL,                -- e.g. 'system_state.bot'
  affected_agent          text        NOT NULL,                -- e.g. 'desk', 'taylor', 'bobby'
  detected_at             timestamptz NOT NULL DEFAULT now(),
  resolved_at             timestamptz,
  root_cause              text        NOT NULL DEFAULT '',
  symptoms                text[]      NOT NULL DEFAULT '{}',
  evidence                jsonb       NOT NULL DEFAULT '{}',
  actions_taken           text[]      NOT NULL DEFAULT '{}',
  recovery_result         text        NOT NULL DEFAULT '',
  user_attention_required boolean     NOT NULL DEFAULT false,
  follow_up_recommendation text       NOT NULL DEFAULT '',
  recurrence_count        int         NOT NULL DEFAULT 1,
  related_events          jsonb       NOT NULL DEFAULT '[]',
  safe_to_trade_status    text        NOT NULL DEFAULT 'unknown'
                                      CHECK (safe_to_trade_status IN (
                                        'paper_mode_safe','live_mode_safe',
                                        'paper_mode_unsafe','live_mode_unsafe','unknown'
                                      )),
  paper_or_live_mode      text        NOT NULL DEFAULT 'paper',
  money_at_risk           boolean     NOT NULL DEFAULT false,
  hall_version            text        NOT NULL DEFAULT 'v1',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS incidents_user_detected_idx
  ON public.incidents(user_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS incidents_status_severity_idx
  ON public.incidents(status, severity);
CREATE INDEX IF NOT EXISTS incidents_affected_agent_idx
  ON public.incidents(user_id, affected_agent, detected_at DESC);

ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own incidents select" ON public.incidents FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own incidents insert" ON public.incidents FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own incidents update" ON public.incidents FOR UPDATE USING (auth.uid() = user_id);

CREATE TRIGGER set_incidents_updated_at
  BEFORE UPDATE ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Vault token + RPC ──────────────────────────────────────────

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

-- ── Cron: every 5 minutes ─────────────────────────────────────

SELECT cron.unschedule('hall-tick-5m') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'hall-tick-5m'
);

DO $$
DECLARE
  v_tok text := public.get_hall_cron_token();
BEGIN
  IF v_tok IS NULL OR v_tok = '' THEN
    RAISE NOTICE 'hall_cron_token not set; skipping hall-tick-5m schedule.';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    'hall-tick-5m',
    '*/5 * * * *',
    format(
      $sql$
        SELECT net.http_post(
          url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/hall',
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || %L
          ),
          body    := jsonb_build_object(
            'cronAll',   true,
            'cronToken', %L
          )
        ) AS request_id;
      $sql$,
      v_tok, v_tok
    )
  );
  RAISE NOTICE 'hall-tick-5m scheduled.';
END;
$$;
