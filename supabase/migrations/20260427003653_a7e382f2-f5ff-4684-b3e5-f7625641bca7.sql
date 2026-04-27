-- Schedule the Brain Trust intelligence sweep every 4 hours.
-- Reuses the existing signal_engine_cron_token (the market-intelligence
-- function recognises that token to enter cron mode).
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'market-intelligence-4h';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'market-intelligence-4h',
  '0 */4 * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/market-intelligence',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || COALESCE(public.get_signal_engine_cron_token(), '')
    ),
    body    := jsonb_build_object('source', 'pg_cron')
  );
  $cron$
);