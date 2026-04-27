-- Enhancement 1: Brain Trust narrative continuity
ALTER TABLE public.market_intelligence
  ADD COLUMN IF NOT EXISTS running_narrative text NULL;

COMMENT ON COLUMN public.market_intelligence.running_narrative IS
  'Evolving market narrative updated each Brain Trust run. Passed to next run for continuity.';

-- Enhancement 2: News flags
ALTER TABLE public.market_intelligence
  ADD COLUMN IF NOT EXISTS news_flags jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.market_intelligence.news_flags IS
  'Material news items flagged by the Crypto Intel Analyst. Read by signal engine.';

-- Enhancement 3: Daily briefs table
CREATE TABLE IF NOT EXISTS public.daily_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  brief_date date NOT NULL,
  brief_text text NOT NULL DEFAULT '',
  session_bias text NOT NULL DEFAULT 'neutral',
  key_levels jsonb NOT NULL DEFAULT '{}'::jsonb,
  watch_symbols text[] NOT NULL DEFAULT '{}',
  caution_flags text[] NOT NULL DEFAULT '{}',
  ai_model text NOT NULL DEFAULT 'google/gemini-2.5-pro',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, brief_date)
);

ALTER TABLE public.daily_briefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own daily_briefs select" ON public.daily_briefs
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own daily_briefs insert" ON public.daily_briefs
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own daily_briefs update" ON public.daily_briefs
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own daily_briefs delete" ON public.daily_briefs
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER trg_daily_briefs_updated_at
  BEFORE UPDATE ON public.daily_briefs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_daily_briefs_user_date
  ON public.daily_briefs (user_id, brief_date DESC);

-- Enhancement 4: Trade Coach grade rollup view
-- Adapted to actual schema: journal_entries.raw->>'tradeId', raw->>'grade', raw->>'regime'
-- (regime captured on the coach entry by post-trade-learn).
CREATE OR REPLACE VIEW public.trade_coach_grades
WITH (security_invoker = true)
AS
SELECT
  j.user_id,
  COALESCE(j.raw->>'symbol', t.symbol) AS symbol,
  COALESCE(NULLIF(j.raw->>'regime', ''), 'unknown') AS regime,
  j.raw->>'grade' AS grade,
  COUNT(*) AS count,
  AVG(
    CASE j.raw->>'grade'
      WHEN 'A' THEN 4.0
      WHEN 'B' THEN 3.0
      WHEN 'C' THEN 2.0
      WHEN 'D' THEN 1.0
      ELSE NULL
    END
  ) AS avg_grade_numeric,
  MAX(j.created_at) AS last_graded_at
FROM public.journal_entries j
LEFT JOIN public.trades t
  ON t.id = (j.raw->>'tradeId')::uuid
WHERE j.kind = 'learning'
  AND j.source = 'trade-coach'
  AND j.raw->>'grade' IS NOT NULL
  AND j.created_at > now() - interval '30 days'
GROUP BY
  j.user_id,
  COALESCE(j.raw->>'symbol', t.symbol),
  COALESCE(NULLIF(j.raw->>'regime', ''), 'unknown'),
  j.raw->>'grade';

GRANT SELECT ON public.trade_coach_grades TO authenticated, service_role;

-- Daily-brief cron token (vault) — matches pattern used by other crons.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'daily_brief_cron_token') THEN
    PERFORM vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'daily_brief_cron_token');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_daily_brief_cron_token()
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'vault'
AS $$
DECLARE
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets
  WHERE name = 'daily_brief_cron_token'
  LIMIT 1;
  RETURN v_token;
END;
$$;

-- Schedule the daily brief cron (07:30 UTC every day).
DO $$
DECLARE
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets
  WHERE name = 'daily_brief_cron_token'
  LIMIT 1;

  -- Unschedule if it already exists (idempotent).
  PERFORM cron.unschedule('daily-brief-morning')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-brief-morning');

  PERFORM cron.schedule(
    'daily-brief-morning',
    '30 7 * * *',
    format($job$
      SELECT net.http_post(
        url := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/daily-brief',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer %s'
        ),
        body := '{}'::jsonb
      ) AS request_id;
    $job$, v_token)
  );
END $$;