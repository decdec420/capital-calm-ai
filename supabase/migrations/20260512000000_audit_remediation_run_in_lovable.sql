-- ============================================================
-- AUDIT REMEDIATION — 2026-05-12
-- Run this entire script in the Lovable SQL Editor (single paste).
-- Every statement is idempotent; safe to run twice.
--
-- What this fixes:
--   1. Creates missing tables: incidents, decision_memory_simulations,
--      strategy_learning_recommendations
--   2. Adds missing columns: experiments.source, ai_provenance columns
--   3. Archives dangerous trend-rev strategy (no tp_r_mult, wrong params)
--   4. Tunes strategy doctrine: vwap-revert gets trending_up regime,
--      momentum-burst and trend-pullback get rsi_max=72 guard
--   5. Registers missing cron jobs: process-decision-memory (10m),
--      enrich-simulations (15m), process-strategy-learning (15m)
--   6. Adds guardrails overhaul columns to doctrine_settings
-- ============================================================


-- ============================================================
-- PART 1: Apply catch-up schema (20260511120000)
-- Paste in the FULL content of:
--   supabase/migrations/20260511120000_catch_up_missing_schema.sql
-- then continue with PART 2 below.
-- ============================================================
-- [The catch_up migration is 838 lines — paste it here or run separately]
-- For reference it is already in your repo at:
--   supabase/migrations/20260511120000_catch_up_missing_schema.sql


-- ============================================================
-- PART 2: Guardrails overhaul — add missing doctrine_settings columns
-- Source: 20260505000000_guardrails_overhaul.sql (key columns only)
-- ============================================================

ALTER TABLE public.doctrine_settings
  ADD COLUMN IF NOT EXISTS max_order_abs_floor     numeric NOT NULL DEFAULT 1.00,
  ADD COLUMN IF NOT EXISTS floor_abs_min            numeric NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS consecutive_loss_limit   int     NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS loss_cooldown_minutes    int     NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS scan_interval_seconds    int     NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS max_correlated_positions int     NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS updated_via              text;


-- ============================================================
-- PART 3: Archive trend-rev v1.3
-- Source: 20260511140000_archive_trend_rev_v1_3.sql
-- Reason: no tp_r_mult, risk_weight=1.0, max_order_pct=0.25 (wrong)
-- ============================================================

UPDATE public.strategies
SET
  status     = 'archived',
  updated_at = NOW()
WHERE name    = 'trend-rev'
  AND version = 'v1.3'
  AND status  = 'approved';


-- ============================================================
-- PART 4: Tune strategy doctrine
-- Source: 20260511150000_tune_strategy_doctrine.sql
-- Fixes 13-day dry spell from trending_up regime coverage gap
-- ============================================================

-- 1. Allow vwap-revert to run in trending_up (RSI-extended fades)
UPDATE public.strategies
SET regime_affinity = array_append(regime_affinity, 'trending_up')
WHERE name = 'vwap-revert'
  AND status = 'approved'
  AND NOT ('trending_up' = ANY(regime_affinity));

-- 2. Add rsi_trending_short_min=75 and rsi_fast_period=7 to vwap-revert
UPDATE public.strategies
SET params = (
  SELECT jsonb_agg(p)
  FROM jsonb_array_elements(COALESCE(params, '[]'::jsonb)) AS p
  WHERE p->>'key' NOT IN ('rsi_trending_short_min', 'rsi_fast_period')
) || '[{"key":"rsi_trending_short_min","value":75},{"key":"rsi_fast_period","value":7}]'::jsonb
WHERE name = 'vwap-revert' AND status = 'approved';

-- 3. Add rsi_max=72 to momentum-burst and trend-pullback
UPDATE public.strategies
SET params = (
  SELECT jsonb_agg(p)
  FROM jsonb_array_elements(COALESCE(params, '[]'::jsonb)) AS p
  WHERE p->>'key' NOT IN ('rsi_max')
) || '[{"key":"rsi_max","value":72}]'::jsonb
WHERE name IN ('momentum-burst', 'trend-pullback')
  AND status = 'approved';


-- ============================================================
-- PART 5: Register missing cron jobs for learning pipeline
-- Source: 20260511130000_fix_crons.sql
-- ============================================================

-- Vault tokens (created only if missing)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'process_decision_memory_cron_token') THEN
    PERFORM vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'process_decision_memory_cron_token',
      'process-decision-memory cron invocation token'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'enrich_simulations_cron_token') THEN
    PERFORM vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'enrich_simulations_cron_token',
      'enrich-simulations cron invocation token'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'process_strategy_learning_cron_token') THEN
    PERFORM vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'process_strategy_learning_cron_token',
      'process-strategy-learning cron invocation token'
    );
  END IF;
END $$;

-- Token retrieval functions
CREATE OR REPLACE FUNCTION public.get_process_decision_memory_cron_token()
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, vault AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
  WHERE name = 'process_decision_memory_cron_token' LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.get_process_decision_memory_cron_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_process_decision_memory_cron_token() TO service_role;

CREATE OR REPLACE FUNCTION public.get_enrich_simulations_cron_token()
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, vault AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
  WHERE name = 'enrich_simulations_cron_token' LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.get_enrich_simulations_cron_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_enrich_simulations_cron_token() TO service_role;

CREATE OR REPLACE FUNCTION public.get_process_strategy_learning_cron_token()
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, vault AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets
  WHERE name = 'process_strategy_learning_cron_token' LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.get_process_strategy_learning_cron_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_process_strategy_learning_cron_token() TO service_role;

-- Schedule: process-decision-memory every 10 minutes
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
      body    := jsonb_build_object('cronAll', true,
                                    'cronToken', COALESCE(public.get_process_decision_memory_cron_token(), ''))
    );
  $$
);

-- Schedule: enrich-simulations every 15 minutes
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
      body    := jsonb_build_object('cronAll', true,
                                    'cronToken', COALESCE(public.get_enrich_simulations_cron_token(), ''))
    );
  $$
);

-- Schedule: process-strategy-learning every 15 minutes
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
      body    := jsonb_build_object('cronAll', true,
                                    'cronToken', COALESCE(public.get_process_strategy_learning_cron_token(), ''))
    );
  $$
);


-- ============================================================
-- VERIFICATION — run after applying to confirm:
-- ============================================================
-- SELECT tablename FROM pg_tables WHERE schemaname = 'public'
--   AND tablename IN ('incidents','decision_memory_simulations','strategy_learning_recommendations')
--   ORDER BY tablename;
-- -- Expected: 3 rows
--
-- SELECT name, status FROM strategies WHERE name = 'trend-rev';
-- -- Expected: status = 'archived'
--
-- SELECT name, regime_affinity FROM strategies WHERE name = 'vwap-revert' AND status = 'approved';
-- -- Expected: trending_up in regime_affinity
--
-- SELECT jobname, schedule FROM cron.job
--   WHERE jobname IN ('process-decision-memory-10m','enrich-simulations-15m','process-strategy-learning-15m');
-- -- Expected: 3 rows
