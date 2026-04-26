-- Drop the service-role-key helper we ended up not needing.
DROP FUNCTION IF EXISTS public.get_service_role_key();

-- Token getter for post-trade-learn.
CREATE OR REPLACE FUNCTION public.get_post_trade_learn_token()
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
  WHERE name = 'post_trade_learn_token'
  LIMIT 1;
  RETURN v_token;
END;
$$;
REVOKE ALL ON FUNCTION public.get_post_trade_learn_token() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_rollover_day_cron_token() FROM PUBLIC, anon, authenticated;

-- Re-create the trigger function to use the new token.
CREATE OR REPLACE FUNCTION public.invoke_post_trade_learn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, net
AS $$
DECLARE
  v_url text := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/post-trade-learn';
  v_token text;
BEGIN
  IF (TG_OP = 'UPDATE'
      AND NEW.status = 'closed'
      AND (OLD.status IS DISTINCT FROM 'closed')) THEN
    BEGIN
      v_token := public.get_post_trade_learn_token();
    EXCEPTION WHEN OTHERS THEN
      v_token := NULL;
    END;
    BEGIN
      PERFORM net.http_post(
        url     := v_url,
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || COALESCE(v_token, '')
        ),
        body    := jsonb_build_object('trade_id', NEW.id)
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;

-- Re-schedule the rollover cron with the dedicated token.
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
      'Authorization', 'Bearer ' || COALESCE(public.get_rollover_day_cron_token(), '')
    ),
    body    := jsonb_build_object('source', 'pg_cron')
  );
  $cron$
);