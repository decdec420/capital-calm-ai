-- ============================================================
-- Fix daily-brief-morning cron job (job 15)
-- ------------------------------------------------------------
-- Two bugs in the original job:
--   1. Hardcoded bearer token instead of vault-backed
--      get_daily_brief_cron_token()
--   2. Body was '{}' — fanout was never set to true, so the
--      function fell through to the JWT path and silently
--      skipped all users. The cron fanout path requires
--      { "fanout": true } in the body.
-- ============================================================

SELECT cron.unschedule('daily-brief-morning');

SELECT cron.schedule(
  'daily-brief-morning',
  '30 7 * * *',
  $$
    SELECT net.http_post(
      url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/daily-brief',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || COALESCE(public.get_daily_brief_cron_token(), '')
      ),
      body    := jsonb_build_object('fanout', true)
    ) AS request_id;
  $$
);
