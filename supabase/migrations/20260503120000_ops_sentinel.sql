-- ============================================================
-- Ops Sentinel — automated watchdog for all desk agents
-- ------------------------------------------------------------
-- Runs every 5 minutes via pg_cron. Pure SQL — no edge runtime
-- dependency so it works even if the edge runtime is down.
--
-- Agents monitored + alert thresholds:
--   signal_engine    → stale after  5 min → CRITICAL
--   jessica/bobby    → stale after  5 min → CRITICAL
--   brain_trust      → stale after  8 hr  → WARNING
--   mark-to-market   → stale after  2 min → CRITICAL
--     (MTM writes system_state.last_mark_to_market_at each tick)
--
-- All alerts are deduplicated: one alert per agent per 30 min
-- (60 min for brain_trust which runs every 4 hours).
-- ============================================================

-- Add last_mark_to_market_at to system_state if missing
-- (mark-to-market writes this each tick but the column may not
--  have been formally migrated yet).
ALTER TABLE public.system_state
  ADD COLUMN IF NOT EXISTS last_mark_to_market_at timestamptz;

-- ─── Main sentinel function ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.check_all_agents_health()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user        RECORD;
  v_health      RECORD;
  v_age_min     int;
  v_mtm_at      timestamptz;
  v_mtm_age     int;
BEGIN
  -- Only watch users whose bot is actively running.
  FOR v_user IN
    SELECT user_id
    FROM   public.system_state
    WHERE  user_id IS NOT NULL
      AND  bot = 'running'
  LOOP

    -- ── Taylor (signal_engine) — max 5 min ───────────────────
    SELECT checked_at, status
    INTO   v_health
    FROM   public.agent_health
    WHERE  user_id   = v_user.user_id
      AND  agent_name = 'signal_engine'
    ORDER  BY checked_at DESC
    LIMIT  1;

    IF v_health.checked_at IS NOT NULL THEN
      v_age_min := EXTRACT(EPOCH FROM (now() - v_health.checked_at))::int / 60;
      IF v_age_min > 5 THEN
        INSERT INTO public.alerts (user_id, severity, title, message)
        SELECT
          v_user.user_id,
          'critical',
          'Ops Sentinel: Taylor (signal-engine) is silent',
          format(
            'Taylor has not reported health in %s minutes (last status: %s). '
            'The signal-engine cron may be down — no new trade signals are being evaluated.',
            v_age_min, COALESCE(v_health.status, 'unknown')
          )
        WHERE NOT EXISTS (
          SELECT 1 FROM public.alerts
          WHERE  user_id    = v_user.user_id
            AND  title      = 'Ops Sentinel: Taylor (signal-engine) is silent'
            AND  created_at > now() - interval '30 minutes'
        );
      END IF;
    END IF;

    -- ── Bobby (jessica) — max 5 min ──────────────────────────
    SELECT checked_at, status
    INTO   v_health
    FROM   public.agent_health
    WHERE  user_id    = v_user.user_id
      AND  agent_name IN ('jessica', 'jessica_heartbeat')
    ORDER  BY checked_at DESC
    LIMIT  1;

    IF v_health.checked_at IS NOT NULL THEN
      v_age_min := EXTRACT(EPOCH FROM (now() - v_health.checked_at))::int / 60;
      IF v_age_min > 5 THEN
        INSERT INTO public.alerts (user_id, severity, title, message)
        SELECT
          v_user.user_id,
          'critical',
          'Ops Sentinel: Bobby (jessica) is silent',
          format(
            'Bobby has not ticked in %s minutes (last status: %s). '
            'The jessica cron may be down — no autonomous decisions are being made.',
            v_age_min, COALESCE(v_health.status, 'unknown')
          )
        WHERE NOT EXISTS (
          SELECT 1 FROM public.alerts
          WHERE  user_id    = v_user.user_id
            AND  title      = 'Ops Sentinel: Bobby (jessica) is silent'
            AND  created_at > now() - interval '30 minutes'
        );
      END IF;
    END IF;

    -- ── Brain Trust (market-intelligence) — max 8 hours ──────
    SELECT checked_at, status
    INTO   v_health
    FROM   public.agent_health
    WHERE  user_id    = v_user.user_id
      AND  agent_name = 'brain_trust'
    ORDER  BY checked_at DESC
    LIMIT  1;

    IF v_health.checked_at IS NOT NULL THEN
      v_age_min := EXTRACT(EPOCH FROM (now() - v_health.checked_at))::int / 60;
      IF v_age_min > 480 THEN
        INSERT INTO public.alerts (user_id, severity, title, message)
        SELECT
          v_user.user_id,
          'warning',
          'Ops Sentinel: Brain Trust (market-intelligence) is stale',
          format(
            'Brain Trust last reported %.1f hours ago (last status: %s). '
            'Market intelligence may be outdated — Bobby is operating on stale macro context.',
            v_age_min::numeric / 60, COALESCE(v_health.status, 'unknown')
          )
        WHERE NOT EXISTS (
          SELECT 1 FROM public.alerts
          WHERE  user_id    = v_user.user_id
            AND  title      = 'Ops Sentinel: Brain Trust (market-intelligence) is stale'
            AND  created_at > now() - interval '4 hours'
        );
      END IF;
    END IF;

    -- ── Mark-to-market — max 2 min ───────────────────────────
    -- MTM writes system_state.last_mark_to_market_at each 15s tick.
    -- If it's been > 2 minutes, stop-loss and TP evaluation are paused.
    SELECT last_mark_to_market_at
    INTO   v_mtm_at
    FROM   public.system_state
    WHERE  user_id = v_user.user_id;

    IF v_mtm_at IS NOT NULL THEN
      v_mtm_age := EXTRACT(EPOCH FROM (now() - v_mtm_at))::int / 60;
      IF v_mtm_age > 2 THEN
        INSERT INTO public.alerts (user_id, severity, title, message)
        SELECT
          v_user.user_id,
          'critical',
          'Ops Sentinel: Mark-to-market is not running',
          format(
            'Mark-to-market last ran %s minutes ago. '
            'Stop-loss triggers and TP evaluations are suspended. '
            'Open positions are unprotected until MTM resumes.',
            v_mtm_age
          )
        WHERE NOT EXISTS (
          SELECT 1 FROM public.alerts
          WHERE  user_id    = v_user.user_id
            AND  title      = 'Ops Sentinel: Mark-to-market is not running'
            AND  created_at > now() - interval '30 minutes'
        );
      END IF;
    END IF;

  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.check_all_agents_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_all_agents_health() TO service_role;

-- ─── Schedule: every 5 minutes ───────────────────────────────
SELECT cron.unschedule('ops-sentinel-5m') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'ops-sentinel-5m'
);

SELECT cron.schedule(
  'ops-sentinel-5m',
  '*/5 * * * *',
  $$ SELECT public.check_all_agents_health(); $$
);
