-- ============================================================
-- Trading profiles: per-user tier selection + faster cron tiers
-- ------------------------------------------------------------
-- Adds a profile column to system_state and provisions two new
-- pg_cron jobs (1-min for aggressive, 2-min for active). Each
-- new cron only fans out to users whose active_profile matches
-- the cron's tier; the existing 5-min cron now restricts itself
-- to sentinel users. This keeps cost bounded and means a user's
-- cadence is determined entirely by their profile choice.
-- ============================================================

-- 1. Column with a safe default. NOT NULL is fine because we backfill
--    every existing row to 'sentinel' via the DEFAULT.
ALTER TABLE public.system_state
  ADD COLUMN IF NOT EXISTS active_profile text NOT NULL DEFAULT 'sentinel';

-- 2. Validation: only the three known tiers are allowed.
--    Use a trigger (not a CHECK constraint) so future tiers can be
--    added without dropping the constraint.
CREATE OR REPLACE FUNCTION public.validate_active_profile()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.active_profile NOT IN ('sentinel', 'active', 'aggressive') THEN
    RAISE EXCEPTION 'active_profile must be one of: sentinel, active, aggressive (got %)', NEW.active_profile;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_active_profile ON public.system_state;
CREATE TRIGGER trg_validate_active_profile
  BEFORE INSERT OR UPDATE OF active_profile ON public.system_state
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_active_profile();

-- 3. Helper that returns user_ids on a given profile tier. Used by the
--    fanout cron payload to select only the relevant users.
CREATE OR REPLACE FUNCTION public.users_on_profile(p_profile text)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT user_id FROM public.system_state WHERE active_profile = p_profile;
$$;

-- 4. Schedule the two new tiers. We reuse the existing
--    `signal_engine_cron_token` vault secret. The signal-engine
--    function still verifies the token — we just additionally
--    pass a `profileTier` hint so it can short-circuit users on
--    the wrong tier (defence-in-depth; the function's per-user
--    logic already reads system_state.active_profile).
DO $$
DECLARE
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets
  WHERE name = 'signal_engine_cron_token'
  LIMIT 1;

  IF v_token IS NULL THEN
    RAISE NOTICE 'signal_engine_cron_token not set; skipping profile-tier cron schedules.';
    RETURN;
  END IF;

  -- Aggressive — every 1 minute.
  PERFORM cron.unschedule('signal-engine-tick-aggressive')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'signal-engine-tick-aggressive');
  PERFORM cron.schedule(
    'signal-engine-tick-aggressive',
    '* * * * *',
    format($job$
      SELECT net.http_post(
        url := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/signal-engine',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer %s'
        ),
        body := jsonb_build_object(
          'cronAll', true,
          'cronToken', '%s',
          'profileTier', 'aggressive'
        )
      ) AS request_id;
    $job$, v_token, v_token)
  );

  -- Active — every 2 minutes.
  PERFORM cron.unschedule('signal-engine-tick-active')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'signal-engine-tick-active');
  PERFORM cron.schedule(
    'signal-engine-tick-active',
    '*/2 * * * *',
    format($job$
      SELECT net.http_post(
        url := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/signal-engine',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer %s'
        ),
        body := jsonb_build_object(
          'cronAll', true,
          'cronToken', '%s',
          'profileTier', 'active'
        )
      ) AS request_id;
    $job$, v_token, v_token)
  );
END $$;

COMMENT ON COLUMN public.system_state.active_profile IS
  'Trading profile tier: sentinel (paper safety harness, 5min scans, $1 orders), active (cautious live, 2min scans, $5 orders), aggressive (1min scans, $25 orders). Determines per-order cap, daily trade cap, daily loss cap, scan cadence, and risk-per-trade %.';