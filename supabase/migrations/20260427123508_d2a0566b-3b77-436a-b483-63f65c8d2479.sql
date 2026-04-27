-- 1) Store the jessica_cron_token in the Supabase vault so pg_cron can read it.
--    The matching env-var secret was added separately (used by the edge function
--    to verify the incoming cron call). They must hold the same value.
DO $$
DECLARE
  v_token text := current_setting('app.settings.jessica_cron_token', true);
BEGIN
  -- If a token already exists with this name, update it; otherwise insert.
  IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'jessica_cron_token') THEN
    -- vault doesn't expose UPDATE via SQL cleanly; rotate by delete + create
    PERFORM vault.update_secret(
      (SELECT id FROM vault.secrets WHERE name = 'jessica_cron_token'),
      COALESCE(v_token, encode(gen_random_bytes(32), 'hex')),
      'jessica_cron_token',
      'Token used by pg_cron to authenticate calls to the jessica edge function'
    );
  ELSE
    PERFORM vault.create_secret(
      COALESCE(v_token, encode(gen_random_bytes(32), 'hex')),
      'jessica_cron_token',
      'Token used by pg_cron to authenticate calls to the jessica edge function'
    );
  END IF;
END $$;

-- 2) Now that the token is guaranteed to exist, schedule Jessica.
DO $$
DECLARE
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets
  WHERE name = 'jessica_cron_token'
  LIMIT 1;

  IF v_token IS NULL THEN
    RAISE NOTICE 'jessica_cron_token still not present after vault insert; aborting schedule.';
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