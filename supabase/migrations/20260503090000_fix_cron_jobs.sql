-- ============================================================
-- Fix broken cron jobs
-- ------------------------------------------------------------
-- Job 22 (position-reconcile-hourly) was inserted with a
-- placeholder URL: https://<your-project-ref>.supabase.co/...
-- and used current_setting('app.reconcile_cron_secret') which
-- is never set, so the job has never executed.
--
-- Fix: replace the placeholder URL with the real project URL
-- and use the signal-engine cron token for Authorization so the
-- function passes its Bearer-header auth check.
-- ============================================================

SELECT cron.unschedule('position-reconcile-hourly');

SELECT cron.schedule(
  'position-reconcile-hourly',
  '0 * * * *',
  $$
    SELECT net.http_post(
      url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/position-reconcile',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || COALESCE(public.get_signal_engine_cron_token(), '')
      ),
      body    := jsonb_build_object('source', 'pg_cron')
    );
  $$
);
