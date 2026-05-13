-- ============================================================
-- PR #51 — Quiet Mode current status + cleanup visibility
-- ------------------------------------------------------------
-- Adds read-only operator status over sanitized system_events and logs
-- cleanup outcomes for deployment-facing visibility. Does not touch trades,
-- doctrine, strategy behavior, signals, broker execution, or safety gates.
-- ============================================================

-- ── 1. Log routine cleanup outcomes without broadening retention ─────────
CREATE OR REPLACE FUNCTION public.cleanup_routine_system_events(p_now timestamptz DEFAULT now())
RETURNS TABLE(deleted_event_type text, deleted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bobby_deleted bigint := 0;
  v_quiet_deleted bigint := 0;
  v_total_deleted bigint := 0;
BEGIN
  -- Routine Bobby narration is useful for recent Ops context but becomes
  -- noisy quickly. Preserve any row that appears incident-linked by payload.
  WITH deleted AS (
    DELETE FROM public.system_events se
     WHERE se.event_type = 'bobby_decision'
       AND se.created_at < p_now - interval '7 days'
       AND NOT (se.payload ? 'incident_id')
       AND NOT (se.payload ? 'incidentId')
       AND COALESCE(se.payload->>'incident_linked', 'false') <> 'true'
     RETURNING se.event_type
  )
  SELECT count(*)::bigint INTO v_bobby_deleted FROM deleted;

  -- Quiet Mode skip breadcrumbs are deduped at write time and retained only
  -- briefly; they are operational cost telemetry, not safety evidence.
  WITH deleted AS (
    DELETE FROM public.system_events se
     WHERE se.event_type = 'quiet_mode_skip'
       AND se.created_at < p_now - interval '3 days'
       AND NOT (se.payload ? 'incident_id')
       AND NOT (se.payload ? 'incidentId')
       AND COALESCE(se.payload->>'incident_linked', 'false') <> 'true'
     RETURNING se.event_type
  )
  SELECT count(*)::bigint INTO v_quiet_deleted FROM deleted;

  v_total_deleted := v_bobby_deleted + v_quiet_deleted;

  INSERT INTO public.system_events (user_id, event_type, actor, payload, created_at)
  SELECT
    p.user_id,
    'cleanup_routine_system_events',
    'system',
    jsonb_build_object(
      'status', 'completed',
      'result', 'completed',
      'deleted_count', v_total_deleted,
      'deleted_counts', jsonb_build_object(
        'bobby_decision', v_bobby_deleted,
        'quiet_mode_skip', v_quiet_deleted
      ),
      'cleanup_scope', 'routine_system_events_only',
      'safety_scope_preserved', true,
      'cron_catalog_visible_to_app', false
    ),
    p_now
  FROM public.profiles p
  WHERE p.user_id IS NOT NULL;

  RETURN QUERY SELECT 'bobby_decision'::text, v_bobby_deleted;
  RETURN QUERY SELECT 'quiet_mode_skip'::text, v_quiet_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_routine_system_events(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_routine_system_events(timestamptz) TO service_role;

COMMENT ON FUNCTION public.cleanup_routine_system_events(timestamptz) IS
  'Deletes only noisy routine system_events: bobby_decision older than 7 days and quiet_mode_skip older than 3 days, then logs a sanitized cleanup_routine_system_events result for each profile. Preserves AI guard, kill switch, broker, incident, trade, portfolio-risk, decision_memory, trade_signals, replay packets, and journal evidence.';

-- ── 2. Read-only current Quiet Mode status RPC ─────────────────
CREATE OR REPLACE FUNCTION public.get_current_quiet_mode_status(p_user_id uuid DEFAULT auth.uid())
RETURNS TABLE(
  mode text,
  latest_reason_codes text[],
  latest_skipped_scope text,
  latest_surface text,
  recommended_cadence_seconds jsonb,
  next_recommended_check_at timestamptz,
  safety_checks_preserved boolean,
  last_quiet_event_at timestamptz,
  last_cleanup_at timestamptz,
  cleanup_status text,
  cleanup_deleted_routine_event_count bigint,
  cleanup_cron_configured boolean,
  cleanup_result text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH latest_quiet AS (
    SELECT se.actor, se.payload, se.created_at
    FROM public.system_events se
    WHERE se.user_id = p_user_id
      AND se.event_type = 'quiet_mode_skip'
    ORDER BY se.created_at DESC
    LIMIT 1
  ),
  quiet_reason_codes AS (
    SELECT coalesce(array_agg(value), ARRAY[]::text[]) AS reason_codes
    FROM latest_quiet lq
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(lq.payload->'reason_codes') = 'array' THEN lq.payload->'reason_codes'
        ELSE '[]'::jsonb
      END
    ) AS value
  ),
  latest_cleanup AS (
    SELECT se.payload, se.created_at
    FROM public.system_events se
    WHERE se.user_id = p_user_id
      AND se.event_type = 'cleanup_routine_system_events'
    ORDER BY se.created_at DESC
    LIMIT 1
  )
  SELECT
    CASE
      WHEN lq.created_at IS NULL THEN 'normal'
      WHEN lq.created_at >= now() - interval '30 minutes' THEN 'quiet'
      ELSE 'normal'
    END AS mode,
    coalesce(qrc.reason_codes, ARRAY[]::text[]) AS latest_reason_codes,
    NULLIF(lq.payload->>'skipped', '') AS latest_skipped_scope,
    CASE WHEN coalesce(lq.payload->>'surface', lq.actor) = 'jessica' THEN 'bobby-orchestration' ELSE NULLIF(coalesce(lq.payload->>'surface', lq.actor), '') END AS latest_surface,
    CASE
      WHEN jsonb_typeof(lq.payload->'recommended_cadence_seconds') = 'object'
        THEN lq.payload->'recommended_cadence_seconds'
      ELSE '{}'::jsonb
    END AS recommended_cadence_seconds,
    CASE
      WHEN (lq.payload->>'next_recommended_check_at') IS NOT NULL
       AND (lq.payload->>'next_recommended_check_at') ~ '^\d{4}-\d{2}-\d{2}T'
        THEN (lq.payload->>'next_recommended_check_at')::timestamptz
      ELSE NULL::timestamptz
    END AS next_recommended_check_at,
    CASE WHEN lq.payload->>'safety_checks_preserved' IN ('true', 'false') THEN (lq.payload->>'safety_checks_preserved')::boolean ELSE false END AS safety_checks_preserved,
    lq.created_at AS last_quiet_event_at,
    lc.created_at AS last_cleanup_at,
    CASE
      WHEN lc.created_at IS NULL THEN 'unknown'
      WHEN COALESCE(lc.payload->>'status', lc.payload->>'result') IN ('failed', 'error') THEN 'failed'
      WHEN lc.created_at < now() - interval '36 hours' THEN 'stale'
      ELSE 'healthy'
    END AS cleanup_status,
    CASE WHEN COALESCE(lc.payload->>'deleted_count', '') ~ '^\d+$' THEN (lc.payload->>'deleted_count')::bigint ELSE 0 END AS cleanup_deleted_routine_event_count,
    NULL::boolean AS cleanup_cron_configured,
    COALESCE(NULLIF(lc.payload->>'status', ''), NULLIF(lc.payload->>'result', '')) AS cleanup_result
  FROM (SELECT 1) seed
  LEFT JOIN latest_quiet lq ON true
  LEFT JOIN quiet_reason_codes qrc ON true
  LEFT JOIN latest_cleanup lc ON true
  WHERE p_user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.get_current_quiet_mode_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_current_quiet_mode_status(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_current_quiet_mode_status(uuid) IS
  'Read-only, user-scoped Quiet Mode status surface. Sanitizes quiet_mode_skip and cleanup_routine_system_events system_events; does not mutate trading, doctrine, signals, broker, or retention state. Cron catalog visibility is intentionally not required for app roles.';
