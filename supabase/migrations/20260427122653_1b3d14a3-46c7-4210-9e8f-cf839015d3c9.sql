-- Jessica — autonomous orchestrator
-- 1) Add a column to system_state to record her last decision summary
ALTER TABLE public.system_state
  ADD COLUMN IF NOT EXISTS last_jessica_decision jsonb;

-- 2) Schedule Jessica to run every minute via pg_cron + pg_net.
--    We reuse the project's existing convention: a vault-stored cron token
--    passed in the request body so the function can authenticate the caller
--    without depending on a JWT for the cron path.
DO $$
DECLARE
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets
  WHERE name = 'jessica_cron_token'
  LIMIT 1;

  IF v_token IS NULL THEN
    RAISE NOTICE 'jessica_cron_token not set in vault; skipping jessica-tick cron schedule. Add the secret and re-run to enable.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('jessica-tick')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'jessica-tick');

  PERFORM cron.schedule(
    'jessica-tick',
    '* * * * *',
    format($job$
      SELECT net.http_post(
        url := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/jessica',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer %s'
        ),
        body := jsonb_build_object('cronAll', true, 'cronToken', '%s')
      ) AS request_id;
    $job$, v_token, v_token)
  );
END $$;

-- Read-accessor function for the jessica cron token (parallel to the other
-- get_*_cron_token helpers used elsewhere in this project).
CREATE OR REPLACE FUNCTION public.get_jessica_cron_token()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets
  WHERE name = 'jessica_cron_token'
  LIMIT 1;
  RETURN v_token;
END;
$function$;

-- NOTE: The existing signal-engine cron stays active as a safety net.
-- Jessica runs alongside it. When Jessica fires run_engine_tick(), Donna may
-- run twice in that minute (Jessica-triggered + cron). That's intentional —
-- harmless, and the engine has idempotency guards.