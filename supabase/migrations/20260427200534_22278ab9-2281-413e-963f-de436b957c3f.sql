CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Drop if it already exists, so this migration is idempotent
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'activate-doctrine-changes-every-5min') THEN
    PERFORM cron.unschedule('activate-doctrine-changes-every-5min');
  END IF;
END $$;

SELECT cron.schedule(
  'activate-doctrine-changes-every-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/activate-doctrine-changes',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.get_activate_doctrine_changes_cron_token()
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);