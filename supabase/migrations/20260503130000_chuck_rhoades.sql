-- ============================================================
-- Chuck Rhoades — weekly compliance review
-- ------------------------------------------------------------
-- 1. Extends strategy_reviews.trigger_type to include 'compliance'
-- 2. Creates vault secret + RPC for the Chuck cron token
-- 3. Schedules chuck-weekly every Sunday at 06:00 UTC
-- ============================================================

-- ── 1. Extend strategy_reviews trigger_type ───────────────────
-- Drop the old CHECK, add the new one that includes 'compliance'.
ALTER TABLE public.strategy_reviews
  DROP CONSTRAINT IF EXISTS strategy_reviews_trigger_type_check;

ALTER TABLE public.strategy_reviews
  ADD CONSTRAINT strategy_reviews_trigger_type_check
  CHECK (trigger_type IN ('weekly_cron', 'trade_milestone', 'manual', 'compliance'));

-- ── 2. Vault secret + RPC ─────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.secrets WHERE name = 'chuck_cron_token'
  ) THEN
    PERFORM vault.create_secret(
      gen_random_uuid()::text,
      'chuck_cron_token',
      'Chuck Rhoades weekly compliance cron invocation token'
    );
    RAISE NOTICE 'chuck_cron_token created in vault.';
  ELSE
    RAISE NOTICE 'chuck_cron_token already exists in vault — no change.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_chuck_cron_token()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT decrypted_secret
  FROM   vault.decrypted_secrets
  WHERE  name = 'chuck_cron_token'
  LIMIT  1;
$$;

REVOKE ALL ON FUNCTION public.get_chuck_cron_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_chuck_cron_token() TO service_role;

-- ── 3. Schedule: every Sunday 06:00 UTC ──────────────────────
SELECT cron.unschedule('chuck-weekly') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'chuck-weekly'
);

DO $$
DECLARE
  v_tok text := public.get_chuck_cron_token();
BEGIN
  IF v_tok IS NULL OR v_tok = '' THEN
    RAISE NOTICE 'chuck_cron_token not set in vault; skipping chuck-weekly schedule.';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    'chuck-weekly',
    '0 6 * * 0',   -- Every Sunday at 06:00 UTC
    format(
      $sql$
        SELECT net.http_post(
          url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/chuck',
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || %L
          ),
          body    := jsonb_build_object(
            'cronAll',   true,
            'cronToken', %L
          )
        ) AS request_id;
      $sql$,
      v_tok, v_tok
    )
  );
  RAISE NOTICE 'chuck-weekly scheduled (Sunday 06:00 UTC).';
END;
$$;
