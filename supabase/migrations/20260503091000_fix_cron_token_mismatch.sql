-- ============================================================
-- Fix cron token mismatch in signal-engine jobs 16 & 17
-- ------------------------------------------------------------
-- Jobs 16 (aggressive, every 1min) and 17 (active, every 2min)
-- were manually inserted with a hardcoded bearer token:
--   7140136edb13aba98d46c0052270950a7e9f71c86a2f91cd542544defc64d2dd
--
-- All other correctly-configured cron jobs use
-- get_signal_engine_cron_token() which reads from vault.
-- If the vault secret differs from the hardcoded string, every
-- tick returns 401 and exits before writing a single DB row —
-- explaining zero journal_entries, zero trade_signals.
--
-- Fix: replace the hardcoded token in both jobs with the
-- vault-backed get_signal_engine_cron_token() call, matching
-- the pattern used by jobs 3, 4, 14, and 21.
-- ============================================================

SELECT cron.unschedule('signal-engine-tick-aggressive');
SELECT cron.unschedule('signal-engine-tick-active');

SELECT cron.schedule(
  'signal-engine-tick-aggressive',
  '* * * * *',
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
        'profileTier', 'aggressive'
      )
    ) AS request_id;
  $$
);

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

-- Also fix jessica-tick (job 18).
-- IMPORTANT: jessica validates body.cronToken against get_jessica_cron_token(),
-- NOT get_signal_engine_cron_token(). Must use the jessica-specific vault token.
SELECT cron.unschedule('jessica-tick');

SELECT cron.schedule(
  'jessica-tick',
  '* * * * *',
  $$
    SELECT net.http_post(
      url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/jessica',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || COALESCE(public.get_jessica_cron_token(), '')
      ),
      body    := jsonb_build_object(
        'cronAll',   true,
        'cronToken', COALESCE(public.get_jessica_cron_token(), '')
      )
    ) AS request_id;
  $$
);
