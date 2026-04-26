-- Make sure pg_net + pg_cron exist (they already do in this project; safe to re-create).
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ─── Helper: fetch the rollover-day cron token from vault ──────────────────
CREATE OR REPLACE FUNCTION public.get_rollover_day_cron_token()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets
  WHERE name = 'rollover_day_cron_token'
  LIMIT 1;
  RETURN v_token;
END;
$$;

-- ─── Helper: fetch the service role key for trigger-driven HTTP calls ─────
-- We deliberately keep this SECURITY DEFINER and locked down — it's only
-- callable from triggers running in the postgres role context.
CREATE OR REPLACE FUNCTION public.get_service_role_key()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_key text;
BEGIN
  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;
  RETURN v_key;
END;
$$;
REVOKE ALL ON FUNCTION public.get_service_role_key() FROM PUBLIC, anon, authenticated;

-- ─── Trigger function: invoke post-trade-learn when a trade closes ────────
CREATE OR REPLACE FUNCTION public.invoke_post_trade_learn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, net
AS $$
DECLARE
  v_url  text := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/post-trade-learn';
  v_key  text;
BEGIN
  -- Only fire on the open → closed transition.
  IF (TG_OP = 'UPDATE'
      AND NEW.status = 'closed'
      AND (OLD.status IS DISTINCT FROM 'closed')) THEN

    BEGIN
      v_key := public.get_service_role_key();
    EXCEPTION WHEN OTHERS THEN
      v_key := NULL;
    END;

    -- Best-effort. Never break the parent transaction.
    BEGIN
      PERFORM net.http_post(
        url     := v_url,
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || COALESCE(v_key, '')
        ),
        body    := jsonb_build_object('trade_id', NEW.id)
      );
    EXCEPTION WHEN OTHERS THEN
      -- swallow — learning is non-critical to trade lifecycle
      NULL;
    END;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invoke_post_trade_learn ON public.trades;
CREATE TRIGGER trg_invoke_post_trade_learn
AFTER UPDATE OF status ON public.trades
FOR EACH ROW
EXECUTE FUNCTION public.invoke_post_trade_learn();

-- ─── Cron: schedule daily rollover at 00:05 UTC ───────────────────────────
-- Unschedule prior version if it exists so re-running is safe.
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'rollover-day-daily';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'rollover-day-daily',
  '5 0 * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/rollover-day',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || COALESCE(public.get_service_role_key(), '')
    ),
    body    := jsonb_build_object('source', 'pg_cron')
  );
  $cron$
);