-- ============================================================
-- PR #47 — Hall/Ops Incident Timeline + Recovery Visibility
-- ------------------------------------------------------------
-- Extends the incidents table with ops-review fields and
-- creates the ops_incidents_timeline view that surfaces both
-- Hall incidents and system_events (AI guard, kill-switch,
-- state changes) as a single ordered timeline.
-- ============================================================

-- ── Extend incidents table ────────────────────────────────────

ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS source_event_type   text,
  ADD COLUMN IF NOT EXISTS affected_workflow   text NOT NULL DEFAULT 'ops',
  ADD COLUMN IF NOT EXISTS trading_blocked     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ops_review_status   text NOT NULL DEFAULT 'detected'
    CHECK (ops_review_status IN (
      'detected','diagnosed','action_taken','verified','resolved','follow_up'
    ));

-- ── ops_incidents_timeline VIEW ───────────────────────────────
-- Normalises both Hall incidents and operational system_events
-- into a single timeline row shape. Read-only — no mutations.
--
-- severity mapping:
--   P1 → critical  P2 → warning  P3 / P4 → info
--   AI_GUARD_REJECTED (read-only surface) → warning
--   AI_GUARD_REJECTED (trade/broker surface) → critical
--   AI_GUARD_FALLBACK → info
--   kill_switch_on → critical
--   state_changed (kill/live) → critical  else → info
--   autonomy_changed, bot_paused → warning

CREATE OR REPLACE VIEW public.ops_incidents_timeline AS

-- ── Branch 1: Hall incidents ──────────────────────────────────
SELECT
  i.id,
  i.user_id,
  'incident'::text                              AS source,
  i.id                                          AS source_id,
  CASE i.severity
    WHEN 'P1' THEN 'critical'
    WHEN 'P2' THEN 'warning'
    ELSE            'info'
  END                                           AS severity,
  -- Map Hall status to ops_review_status for display
  COALESCE(
    NULLIF(i.ops_review_status, 'detected'),
    CASE i.status
      WHEN 'resolved'     THEN 'resolved'
      WHEN 'standing_by'  THEN 'diagnosed'
      ELSE                     'detected'
    END
  )                                             AS ops_status,
  i.status                                      AS hall_status,
  i.source_event_type,
  i.affected_workflow,
  i.affected_agent                              AS affected_agent,
  i.affected_system                             AS affected_system,
  i.trading_blocked,
  i.money_at_risk,
  i.paper_or_live_mode                         AS mode,
  i.user_attention_required,
  i.root_cause,
  i.evidence,
  i.actions_taken,
  i.recovery_result,
  i.follow_up_recommendation,
  i.detected_at                                AS created_at,
  i.resolved_at,
  i.updated_at,
  i.incident_id                                AS human_id,
  i.symptoms                                   AS tags

FROM public.incidents i

UNION ALL

-- ── Branch 2: Operational system_events ──────────────────────
-- Only the event types that are operationally significant.
-- Raw AI output is never stored here — only sanitized metadata.
SELECT
  se.id,
  se.user_id,
  'system_event'::text                          AS source,
  se.id                                         AS source_id,
  -- Severity
  CASE se.event_type
    WHEN 'AI_GUARD_REJECTED' THEN
      CASE
        WHEN (se.payload->>'surface') IN ('trade_signal','broker_execution','jessica_decision')
          THEN 'critical'
        ELSE 'warning'
      END
    WHEN 'AI_GUARD_FALLBACK'        THEN 'info'
    WHEN 'kill_switch_on'           THEN 'critical'
    WHEN 'kill_switch_off'          THEN 'info'
    WHEN 'state_changed'            THEN
      CASE
        WHEN (se.payload->>'kill_switch_engaged') = 'true'  THEN 'critical'
        WHEN (se.payload->>'live_trading_enabled') = 'true' THEN 'warning'
        ELSE 'info'
      END
    WHEN 'bot_paused'               THEN 'warning'
    WHEN 'bot_resumed'              THEN 'info'
    WHEN 'autonomy_changed'         THEN 'info'
    ELSE                                 'info'
  END                                           AS severity,
  'detected'::text                              AS ops_status,
  'open'::text                                  AS hall_status,
  se.event_type                                 AS source_event_type,
  -- Affected workflow
  CASE se.event_type
    WHEN 'AI_GUARD_REJECTED'  THEN COALESCE(se.payload->>'surface', 'ops')
    WHEN 'AI_GUARD_FALLBACK'  THEN COALESCE(se.payload->>'surface', 'ops')
    WHEN 'kill_switch_on'     THEN 'trade_decision'
    WHEN 'kill_switch_off'    THEN 'trade_decision'
    WHEN 'state_changed'      THEN 'ops'
    WHEN 'bot_paused'         THEN 'ops'
    WHEN 'bot_resumed'        THEN 'ops'
    WHEN 'autonomy_changed'   THEN 'ops'
    ELSE                           'ops'
  END                                           AS affected_workflow,
  se.actor                                      AS affected_agent,
  se.event_type                                 AS affected_system,
  -- trading_blocked
  CASE se.event_type
    WHEN 'kill_switch_on'  THEN true
    WHEN 'AI_GUARD_REJECTED' THEN
      CASE
        WHEN (se.payload->>'surface') IN ('trade_signal','broker_execution','jessica_decision')
          THEN true
        ELSE false
      END
    WHEN 'state_changed' THEN
      CASE WHEN (se.payload->>'kill_switch_engaged') = 'true' THEN true ELSE false END
    ELSE false
  END                                           AS trading_blocked,
  false                                         AS money_at_risk,
  'unknown'::text                               AS mode,
  -- user_attention_required
  CASE se.event_type
    WHEN 'AI_GUARD_REJECTED' THEN
      CASE
        WHEN (se.payload->>'surface') IN ('trade_signal','broker_execution','jessica_decision')
          THEN true
        ELSE false
      END
    WHEN 'kill_switch_on' THEN true
    ELSE false
  END                                           AS user_attention_required,
  -- root_cause from sanitized payload fields
  COALESCE(
    se.payload->>'sanitizedReason',
    se.payload->>'reason',
    se.event_type
  )                                             AS root_cause,
  -- Strip any unsafe fields from evidence — keep only known-safe keys
  jsonb_build_object(
    'surface',              se.payload->'surface',
    'decisionType',         se.payload->'decisionType',
    'validationStatus',     se.payload->'validationStatus',
    'unsafeIntentCount',    se.payload->'unsafeIntentCount',
    'protectedActionCount', se.payload->'protectedActionCount',
    'actor',                to_jsonb(se.actor)
  )                                             AS evidence,
  ARRAY[]::text[]                               AS actions_taken,
  ''::text                                      AS recovery_result,
  ''::text                                      AS follow_up_recommendation,
  se.created_at,
  NULL::timestamptz                             AS resolved_at,
  se.created_at                                 AS updated_at,
  'sys_' || left(se.id::text, 8)                AS human_id,
  ARRAY[se.event_type]::text[]                  AS tags

FROM public.system_events se
WHERE se.event_type IN (
  'AI_GUARD_REJECTED',
  'AI_GUARD_FALLBACK',
  'kill_switch_on',
  'kill_switch_off',
  'state_changed',
  'bot_paused',
  'bot_resumed',
  'autonomy_changed'
);

-- Grant read access to authenticated users (RLS applies to base tables)
GRANT SELECT ON public.ops_incidents_timeline TO authenticated;

-- ── RPC: update ops_review_status ────────────────────────────
-- Allows the UI to advance the review lifecycle on an incident.
-- ONLY mutates ops_review_status on the incidents table.
-- Cannot mutate trading state, strategies, doctrine, or signals.

CREATE OR REPLACE FUNCTION public.update_incident_ops_status(
  p_incident_id  uuid,
  p_ops_status   text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_ops_status NOT IN ('detected','diagnosed','action_taken','verified','resolved','follow_up') THEN
    RAISE EXCEPTION 'Invalid ops_review_status: %', p_ops_status;
  END IF;

  UPDATE public.incidents
     SET ops_review_status = p_ops_status,
         updated_at        = now(),
         resolved_at       = CASE WHEN p_ops_status = 'resolved' THEN now() ELSE resolved_at END
   WHERE id      = p_incident_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incident not found or access denied';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_incident_ops_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_incident_ops_status(uuid, text) TO authenticated;
