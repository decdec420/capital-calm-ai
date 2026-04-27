-- ─── strategy_reviews — Katrina's written analysis of strategy performance ─────
-- One row per Katrina run. Read by the Learning tab and surfaced to Harvey.
-- Per project convention: NO foreign key to auth.users. RLS enforces ownership.

CREATE TABLE IF NOT EXISTS public.strategy_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  reviewed_at     timestamptz NOT NULL DEFAULT now(),
  trigger_type    text NOT NULL CHECK (trigger_type IN ('weekly_cron', 'trade_milestone', 'manual')),
  trades_analyzed int  NOT NULL DEFAULT 0,
  brief_text      text NOT NULL,
  promote_ids     uuid[] NOT NULL DEFAULT '{}',
  kill_ids        uuid[] NOT NULL DEFAULT '{}',
  continue_ids    uuid[] NOT NULL DEFAULT '{}',
  top_regime      text,
  worst_regime    text,
  win_rate_trend  text CHECK (win_rate_trend IN ('improving', 'stable', 'declining')),
  ai_model        text,
  raw_analysis    jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS strategy_reviews_user_time_idx
  ON public.strategy_reviews(user_id, reviewed_at DESC);

ALTER TABLE public.strategy_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read their own strategy reviews" ON public.strategy_reviews;
CREATE POLICY "Users can read their own strategy reviews"
  ON public.strategy_reviews FOR SELECT
  USING (auth.uid() = user_id);

-- Writes happen exclusively from the katrina edge function via the service role,
-- which bypasses RLS. No INSERT/UPDATE/DELETE policies for end users.

-- ─── katrina_cron_token in the vault ──────────────────────────────────────
-- Matches the established pattern (jessica, evaluate-candidate, signal-engine).
DO $$
DECLARE
  v_existing text;
  v_new      text;
BEGIN
  SELECT decrypted_secret INTO v_existing
  FROM vault.decrypted_secrets
  WHERE name = 'katrina_cron_token'
  LIMIT 1;

  IF v_existing IS NULL THEN
    v_new := encode(extensions.gen_random_bytes(32), 'hex');
    PERFORM vault.create_secret(v_new, 'katrina_cron_token', 'Cron auth token for the katrina (strategy review) edge function');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_katrina_cron_token()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets
  WHERE name = 'katrina_cron_token'
  LIMIT 1;
  RETURN v_token;
END;
$$;
REVOKE ALL ON FUNCTION public.get_katrina_cron_token() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_katrina_cron_token() TO service_role;

-- ─── Schedule: Sunday 08:00 UTC ───────────────────────────────────────────
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'katrina-weekly-review';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'katrina-weekly-review',
  '0 8 * * 0',
  $cron$
  SELECT net.http_post(
    url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/katrina',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || COALESCE(public.get_katrina_cron_token(), '')
    ),
    body    := jsonb_build_object('trigger', 'weekly_cron')
  );
  $cron$
);