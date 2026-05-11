-- ============================================================
-- Runtime audit cron fixes — 2026-05-11
-- ------------------------------------------------------------
-- Issues addressed:
--   1. signal-engine-tick-active (2min) is redundant — the 1min
--      aggressive job already covers frequent scanning. Remove it.
--   2. process-decision-memory has no cron job.
--   3. enrich-simulations has no cron job.
--   4. process-strategy-learning has no cron job.
--   5. mark-to-market-15s runs */15 * * * * (every 15 MINUTES)
--      but was always intended to run every 15 SECONDS (*/15 * * * * *).
-- ============================================================

-- ── 1. Remove the redundant 2-min signal-engine-tick-active job ──

SELECT cron.unschedule('signal-engine-tick-active')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'signal-engine-tick-active');

-- ── 2. Vault secret + token function for process-decision-memory ──

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.secrets WHERE name = 'process_decision_memory_cron_token'
  ) THEN
    PERFORM vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'process_decision_memory_cron_token',
      'process-decision-memory cron invocation token'
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_process_decision_memory_cron_token()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE name = 'process_decision_memory_cron_token'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_process_decision_memory_cron_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_process_decision_memory_cron_token() TO service_role;

-- ── 3. Vault secret + token function for enrich-simulations ──

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.secrets WHERE name = 'enrich_simulations_cron_token'
  ) THEN
    PERFORM vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'enrich_simulations_cron_token',
      'enrich-simulations cron invocation token'
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_enrich_simulations_cron_token()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE name = 'enrich_simulations_cron_token'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_enrich_simulations_cron_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_enrich_simulations_cron_token() TO service_role;

-- ── 4. Vault secret + token function for process-strategy-learning ──

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.secrets WHERE name = 'process_strategy_learning_cron_token'
  ) THEN
    PERFORM vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'process_strategy_learning_cron_token',
      'process-strategy-learning cron invocation token'
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_process_strategy_learning_cron_token()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE name = 'process_strategy_learning_cron_token'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_process_strategy_learning_cron_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_process_strategy_learning_cron_token() TO service_role;

-- ── 5. Schedule process-decision-memory (every 10 minutes) ──

SELECT cron.unschedule('process-decision-memory-10m')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-decision-memory-10m');

SELECT cron.schedule(
  'process-decision-memory-10m',
  '*/10 * * * *',
  $$
    SELECT net.http_post(
      url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/process-decision-memory',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || COALESCE(public.get_process_decision_memory_cron_token(), '')
      ),
      body    := jsonb_build_object(
        'cronAll',   true,
        'cronToken', COALESCE(public.get_process_decision_memory_cron_token(), '')
      )
    ) AS request_id;
  $$
);

-- ── 6. Schedule enrich-simulations (every 15 minutes) ──

SELECT cron.unschedule('enrich-simulations-15m')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'enrich-simulations-15m');

SELECT cron.schedule(
  'enrich-simulations-15m',
  '*/15 * * * *',
  $$
    SELECT net.http_post(
      url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/enrich-simulations',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || COALESCE(public.get_enrich_simulations_cron_token(), '')
      ),
      body    := jsonb_build_object(
        'cronAll',   true,
        'cronToken', COALESCE(public.get_enrich_simulations_cron_token(), '')
      )
    ) AS request_id;
  $$
);

-- ── 7. Schedule process-strategy-learning (every 15 minutes) ──

SELECT cron.unschedule('process-strategy-learning-15m')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-strategy-learning-15m');

SELECT cron.schedule(
  'process-strategy-learning-15m',
  '*/15 * * * *',
  $$
    SELECT net.http_post(
      url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/process-strategy-learning',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || COALESCE(public.get_process_strategy_learning_cron_token(), '')
      ),
      body    := jsonb_build_object(
        'cronAll',   true,
        'cronToken', COALESCE(public.get_process_strategy_learning_cron_token(), '')
      )
    ) AS request_id;
  $$
);

-- ── 8. Fix mark-to-market: was */15 * * * * (every 15 MINUTES),
--       correct schedule is */15 * * * * * (every 15 SECONDS) ──

SELECT cron.unschedule('mark-to-market-15s')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mark-to-market-15s');

SELECT cron.schedule(
  'mark-to-market-15s',
  '*/15 * * * * *',
  $$
    SELECT net.http_post(
      url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/mark-to-market',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || COALESCE(public.get_mark_to_market_cron_token(), '')
      ),
      body    := jsonb_build_object('cronAll', true)
    ) AS request_id;
  $$
);
