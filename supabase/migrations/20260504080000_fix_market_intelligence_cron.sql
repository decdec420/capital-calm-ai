-- ============================================================
-- Fix: market-intelligence cron cadence mismatch
-- ------------------------------------------------------------
-- Problem: market-intelligence-4h runs every 4 hours, but
-- signal-engine requires recent_momentum_at < 120 minutes old.
-- This means BRAIN_TRUST_MOMENTUM_STALE gate hard-blocks ALL
-- trades for 2+ hours of every 4-hour cycle.
--
-- The market-intelligence code was always designed for 1-minute
-- cadence (MAFEE_FRESHNESS_MS = 0, code comment says "every
-- cron tick ~1 min"). The 4h schedule was a mismatch.
--
-- Fix: reschedule to every 1 minute.
--   - Mafee (recent_momentum_1h/4h) always re-runs → gate never stale
--   - Bill freshness gate (5 min) still limits AI spend
--   - Hall freshness gate (15 min) still limits AI spend
-- ============================================================

SELECT cron.unschedule('market-intelligence-4h');

SELECT cron.schedule(
  'market-intelligence-1m',
  '* * * * *',
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
