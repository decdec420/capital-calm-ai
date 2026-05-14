-- ============================================================
-- PR #52 — Admin-safe cron health status
-- ------------------------------------------------------------
-- Adds a service-role-only sanitized read path over cron.job and
-- cron.job_run_details. Does not expose raw cron commands, HTTP headers,
-- Vault values, or failure payloads to app users.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_cron_health_status(p_user_id uuid DEFAULT NULL, p_now timestamptz DEFAULT now())
RETURNS TABLE(
  job_name text,
  category text,
  configured boolean,
  last_run_at timestamptz,
  last_status text,
  last_safe_message text,
  expected_every_seconds integer,
  stale boolean,
  severity text,
  user_attention_required boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, cron
AS $$
  WITH catalog(job_name, category, expected_every_seconds, stale_multiplier, critical_when_missing, optional_job) AS (
    VALUES
      ('cleanup-routine-system-events-daily'::text, 'retention'::text, 86400::integer, 2.0::numeric, false::boolean, false::boolean),
      ('signal-engine-tick-aggressive', 'trading', 60, 5.0, false, false),
      ('market-intelligence-1m', 'market_data', 60, 10.0, false, false),
      ('jessica-tick', 'ops', 60, 5.0, false, false),
      ('mark-to-market-15s', 'safety', 15, 8.0, true, false),
      ('process-decision-memory-10m', 'learning', 600, 3.0, false, false),
      ('enrich-simulations-15m', 'learning', 900, 3.0, false, false),
      ('process-strategy-learning-15m', 'learning', 900, 3.0, false, false),
      ('hall-tick-5m', 'ops', 300, 3.0, false, false)
  ),
  open_position_risk AS (
    SELECT EXISTS (
      SELECT 1
      FROM public.trades t
      WHERE p_user_id IS NOT NULL
        AND t.user_id = p_user_id
        AND t.status = 'open'
      LIMIT 1
    ) AS has_open_positions
  ),
  jobs AS (
    SELECT j.jobid, j.jobname, COALESCE(j.active, true) AS active
    FROM cron.job j
  ),
  last_runs AS (
    SELECT DISTINCT ON (d.jobid)
      d.jobid,
      COALESCE(d.start_time, d.end_time) AS run_at,
      CASE
        WHEN lower(COALESCE(d.status, '')) IN ('succeeded', 'success') THEN 'succeeded'
        WHEN lower(COALESCE(d.status, '')) IN ('failed', 'error') THEN 'failed'
        WHEN lower(COALESCE(d.status, '')) IN ('running', 'started') THEN 'running'
        ELSE 'unknown'
      END AS safe_status
    FROM cron.job_run_details d
    ORDER BY d.jobid, COALESCE(d.start_time, d.end_time) DESC NULLS LAST, d.runid DESC
  ),
  classified AS (
    SELECT
      c.job_name,
      c.category,
      (j.jobid IS NOT NULL AND j.active) AS configured,
      lr.run_at AS last_run_at,
      COALESCE(lr.safe_status, 'unknown') AS last_status,
      c.expected_every_seconds,
      CASE
        WHEN j.jobid IS NULL OR NOT j.active THEN false
        WHEN lr.run_at IS NULL THEN true
        WHEN lr.safe_status = 'running' THEN p_now > lr.run_at + make_interval(secs => (c.expected_every_seconds * c.stale_multiplier)::integer)
        ELSE p_now > lr.run_at + make_interval(secs => (c.expected_every_seconds * c.stale_multiplier)::integer)
      END AS stale,
      c.critical_when_missing,
      c.optional_job,
      opr.has_open_positions
    FROM catalog c
    LEFT JOIN jobs j ON j.jobname = c.job_name
    LEFT JOIN last_runs lr ON lr.jobid = j.jobid
    CROSS JOIN open_position_risk opr
  )
  SELECT
    cl.job_name,
    cl.category,
    cl.configured,
    cl.last_run_at,
    cl.last_status,
    CASE
      WHEN NOT cl.configured THEN 'Cron job is not configured or inactive.'
      WHEN cl.last_status = 'succeeded' AND NOT cl.stale THEN 'Last run completed.'
      WHEN cl.last_status = 'running' AND NOT cl.stale THEN 'Run currently in progress.'
      WHEN cl.last_status = 'failed' THEN 'Last run failed. Check Supabase Cron logs with admin access.'
      WHEN cl.stale THEN 'No recent successful run inside expected window.'
      ELSE 'Cron status unknown. Check Supabase Cron logs with admin access.'
    END AS last_safe_message,
    cl.expected_every_seconds,
    cl.stale,
    CASE
      WHEN NOT cl.configured AND (cl.critical_when_missing OR (cl.job_name = 'mark-to-market-15s' AND cl.has_open_positions)) THEN 'critical'
      WHEN cl.last_status = 'failed' AND cl.job_name = 'mark-to-market-15s' AND cl.has_open_positions THEN 'critical'
      WHEN cl.stale AND cl.job_name = 'mark-to-market-15s' AND cl.has_open_positions THEN 'critical'
      WHEN NOT cl.configured THEN CASE WHEN cl.optional_job THEN 'info' ELSE 'warning' END
      WHEN cl.last_status = 'failed' THEN 'warning'
      WHEN cl.stale THEN 'warning'
      WHEN cl.last_status = 'running' THEN 'info'
      WHEN cl.last_status = 'succeeded' THEN 'ok'
      ELSE 'warning'
    END AS severity,
    CASE
      WHEN NOT cl.configured THEN true
      WHEN cl.last_status = 'failed' THEN true
      WHEN cl.stale THEN true
      ELSE false
    END AS user_attention_required
  FROM classified cl
  ORDER BY
    CASE
      WHEN (CASE
        WHEN NOT cl.configured AND (cl.critical_when_missing OR (cl.job_name = 'mark-to-market-15s' AND cl.has_open_positions)) THEN 'critical'
        WHEN cl.last_status = 'failed' AND cl.job_name = 'mark-to-market-15s' AND cl.has_open_positions THEN 'critical'
        WHEN cl.stale AND cl.job_name = 'mark-to-market-15s' AND cl.has_open_positions THEN 'critical'
        WHEN NOT cl.configured THEN CASE WHEN cl.optional_job THEN 'info' ELSE 'warning' END
        WHEN cl.last_status = 'failed' THEN 'warning'
        WHEN cl.stale THEN 'warning'
        WHEN cl.last_status = 'running' THEN 'info'
        WHEN cl.last_status = 'succeeded' THEN 'ok'
        ELSE 'warning'
      END) = 'critical' THEN 0
      WHEN (CASE
        WHEN NOT cl.configured AND (cl.critical_when_missing OR (cl.job_name = 'mark-to-market-15s' AND cl.has_open_positions)) THEN 'critical'
        WHEN cl.last_status = 'failed' AND cl.job_name = 'mark-to-market-15s' AND cl.has_open_positions THEN 'critical'
        WHEN cl.stale AND cl.job_name = 'mark-to-market-15s' AND cl.has_open_positions THEN 'critical'
        WHEN NOT cl.configured THEN CASE WHEN cl.optional_job THEN 'info' ELSE 'warning' END
        WHEN cl.last_status = 'failed' THEN 'warning'
        WHEN cl.stale THEN 'warning'
        WHEN cl.last_status = 'running' THEN 'info'
        WHEN cl.last_status = 'succeeded' THEN 'ok'
        ELSE 'warning'
      END) = 'warning' THEN 1
      WHEN cl.last_status = 'running' THEN 2
      ELSE 3
    END,
    cl.job_name;
$$;

REVOKE ALL ON FUNCTION public.get_cron_health_status(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_cron_health_status(uuid, timestamptz) TO service_role;

COMMENT ON FUNCTION public.get_cron_health_status(uuid, timestamptz) IS
  'Service-role-only sanitized cron health read path. Reads cron.job and cron.job_run_details but returns only configured/last-run/status/staleness/severity. Never exposes raw cron commands, HTTP headers, bearer tokens, Vault secret names/values, or raw failure payloads. Observability only; does not mutate trading, doctrine, signals, broker, or strategy state.';
