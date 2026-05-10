-- =============================================================================
-- PR #40 — process-strategy-learning cron wiring
-- =============================================================================
-- Registers process-strategy-learning to run every 4 hours via pg_cron.
--
-- Schedule rationale:
--   • enrich-simulations runs hourly (writes completed simulation results)
--   • process-decision-memory runs every 30m (drains queue → creates simulations)
--   • process-strategy-learning runs every 4h — downstream consumer that needs
--     enough enriched simulations to form statistically meaningful groups.
--     Running more frequently wastes CPU; 4h gives ample evidence accumulation.
--
-- Pipeline order (per user session):
--   1. signal-engine          → creates decision_memory rows on each blocked signal
--   2. process-decision-memory → queues simulations for each decision_memory row
--   3. enrich-simulations      → fetches forward candles, writes result + status=completed
--   4. process-strategy-learning (this cron) → groups completed sims → recommendations
--
-- Safety: this function NEVER:
--   - Places, approves, or modifies trades.
--   - Calls broker endpoints.
--   - Mutates strategies, doctrine, or risk gates.
--   - Auto-accepts any recommendation.
--   - Weakens safety blocks.
--
-- All outputs are strategy_learning_recommendations rows with status='pending_review'.
-- =============================================================================

-- ── 1. Generate (if missing) and store cron token in vault ───────────────────
DO $$
DECLARE
  v_existing text;
  v_new      text;
BEGIN
  SELECT decrypted_secret INTO v_existing
  FROM   vault.decrypted_secrets
  WHERE  name = 'strategy_learning_cron_token'
  LIMIT  1;

  IF v_existing IS NULL THEN
    v_new := encode(extensions.gen_random_bytes(32), 'hex');
    PERFORM vault.create_secret(
      v_new,
      'strategy_learning_cron_token',
      'Cron auth token for process-strategy-learning edge function'
    );
  END IF;
END $$;

-- ── 2. RPC — retrieve token for cron use ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_strategy_learning_cron_token()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM   vault.decrypted_secrets
  WHERE  name = 'strategy_learning_cron_token'
  LIMIT  1;
  RETURN v_token;
END;
$$;

REVOKE ALL   ON FUNCTION public.get_strategy_learning_cron_token() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_strategy_learning_cron_token() TO service_role;

-- ── 3. Schedule cron — every 4 hours ─────────────────────────────────────────
-- Unschedule any previous version first (idempotent).
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid
  FROM   cron.job
  WHERE  jobname = 'process-strategy-learning-4h';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'process-strategy-learning-4h',
  '0 */4 * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/process-strategy-learning',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || COALESCE(public.get_strategy_learning_cron_token(), '')
    ),
    body    := jsonb_build_object('source', 'pg_cron')
  );
  $cron$
);
