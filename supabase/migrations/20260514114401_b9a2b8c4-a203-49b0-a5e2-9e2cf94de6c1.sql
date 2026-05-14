
-- Restore the signal-engine cron for users on the 'active' profile.
-- Earlier this was unscheduled as "redundant" but the aggressive cron
-- only fans out to users whose active_profile='aggressive'. Users on
-- 'active' (or 'sentinel') were left with NO cron — their engine
-- hadn't ticked in 32+ hours, which made Jessica's auto-recovery
-- fire 'run_engine_tick' every minute and torch the AI budget.

SELECT cron.schedule(
  'signal-engine-tick-active',
  '*/2 * * * *',
  $$
    SELECT net.http_post(
      url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/signal-engine',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || COALESCE(public.get_signal_engine_cron_token(), '')
      ),
      body    := jsonb_build_object(
        'cronAll',     true,
        'cronToken',   COALESCE(public.get_signal_engine_cron_token(), ''),
        'profileTier', 'active'
      )
    ) AS request_id;
  $$
);

SELECT cron.schedule(
  'signal-engine-tick-sentinel',
  '*/5 * * * *',
  $$
    SELECT net.http_post(
      url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/signal-engine',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || COALESCE(public.get_signal_engine_cron_token(), '')
      ),
      body    := jsonb_build_object(
        'cronAll',     true,
        'cronToken',   COALESCE(public.get_signal_engine_cron_token(), ''),
        'profileTier', 'sentinel'
      )
    ) AS request_id;
  $$
);
