-- ============================================================
-- PR #50 — Quiet Mode retention + cron dedup audit
-- ------------------------------------------------------------
-- Keep safety crons intact, reduce duplicate cron work, and prune only
-- routine/noisy system_events. This migration does NOT touch trades,
-- trade_signals, decision_memory, replay packets, or journal_entries.
-- ============================================================

-- ── 1. Cron overlap audit / dedup ───────────────────────────
-- Historical migrations scheduled both signal-engine-tick-aggressive (1m)
-- and signal-engine-tick-active (2m). The 2026-05-11 catch-up migration
-- already removed signal-engine-tick-active; keep this idempotent guard so
-- restored databases cannot double-fire Taylor for the same function.
SELECT cron.unschedule('signal-engine-tick-active')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'signal-engine-tick-active');

-- Older environments briefly used a generic mark-to-market job in addition
-- to the canonical mark-to-market-15s safety job. Keep the canonical 15s job;
-- remove only the duplicate generic name if present.
SELECT cron.unschedule('mark-to-market')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mark-to-market');

-- Do not unschedule jessica-tick, signal-engine-tick-aggressive,
-- market-intelligence-1m, hall-watchdog-5m, or mark-to-market-15s here.
-- Quiet Mode now performs profile/idle throttling inside the Edge Functions
-- so safety coverage remains visible to Hall/Ops.

-- ── 2. Routine system_events retention ──────────────────────
CREATE OR REPLACE FUNCTION public.cleanup_routine_system_events(p_now timestamptz DEFAULT now())
RETURNS TABLE(deleted_event_type text, deleted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Routine Bobby narration is useful for recent Ops context but becomes
  -- noisy quickly. Preserve any row that appears incident-linked by payload.
  RETURN QUERY
  WITH deleted AS (
    DELETE FROM public.system_events se
     WHERE se.event_type = 'bobby_decision'
       AND se.created_at < p_now - interval '7 days'
       AND NOT (se.payload ? 'incident_id')
       AND NOT (se.payload ? 'incidentId')
       AND COALESCE(se.payload->>'incident_linked', 'false') <> 'true'
     RETURNING se.event_type
  )
  SELECT 'bobby_decision'::text, count(*)::bigint FROM deleted;

  -- Quiet Mode skip breadcrumbs are deduped at write time and retained only
  -- briefly; they are operational cost telemetry, not safety evidence.
  RETURN QUERY
  WITH deleted AS (
    DELETE FROM public.system_events se
     WHERE se.event_type = 'quiet_mode_skip'
       AND se.created_at < p_now - interval '3 days'
       AND NOT (se.payload ? 'incident_id')
       AND NOT (se.payload ? 'incidentId')
       AND COALESCE(se.payload->>'incident_linked', 'false') <> 'true'
     RETURNING se.event_type
  )
  SELECT 'quiet_mode_skip'::text, count(*)::bigint FROM deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_routine_system_events(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_routine_system_events(timestamptz) TO service_role;

COMMENT ON FUNCTION public.cleanup_routine_system_events(timestamptz) IS
  'Deletes only noisy routine system_events: bobby_decision older than 7 days and quiet_mode_skip older than 3 days. Preserves AI guard, kill switch, broker, incident, trade, portfolio-risk, decision_memory, trade_signals, replay packets, and journal evidence.';

-- ── 3. Daily cleanup schedule ───────────────────────────────
-- Database-local cron: no Edge Function token needed, no duplicate HTTP job.
SELECT cron.unschedule('cleanup-routine-system-events-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-routine-system-events-daily');

SELECT cron.schedule(
  'cleanup-routine-system-events-daily',
  '17 3 * * *',
  $$ SELECT * FROM public.cleanup_routine_system_events(now()); $$
);

-- ── 4. Selective IO index ───────────────────────────────────
-- Existing indexes cover (user_id, created_at) and (user_id,event_type,created_at).
-- The retention job filters by event_type + created_at globally, so add one
-- narrow partial index for only the two prunable event types. This improves
-- cleanup scans without increasing write cost for safety/audit event types.
CREATE INDEX IF NOT EXISTS idx_system_events_routine_retention
  ON public.system_events (event_type, created_at)
  WHERE event_type IN ('bobby_decision', 'quiet_mode_skip');
