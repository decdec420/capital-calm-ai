// ============================================================
// useOpsTimeline — Hall/Ops incident timeline data hook
// ------------------------------------------------------------
// Fetches and merges:
//   1. Hall incidents (incidents table, recent 50)
//   2. Operational system_events (AI guard + state changes, recent 50)
//
// Returns a unified, sorted timeline (newest first).
// Exposes metadata-only update actions (ops_review_status only).
// These actions CANNOT mutate trading state, strategies, or signals.
// ============================================================

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useTableChanges } from "@/hooks/useRealtimeSubscriptions";
import {
  classifyEventType,
  type IncidentSeverity,
  type AffectedWorkflow,
  type OpsReviewStatus,
} from "@/lib/incident-classification";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OpsTimelineEntry {
  id: string;
  source: "incident" | "system_event";
  sourceId: string;
  humanId: string;
  severity: IncidentSeverity;
  opsStatus: OpsReviewStatus;
  hallStatus: string;
  sourceEventType: string | null;
  affectedWorkflow: AffectedWorkflow;
  affectedAgent: string;
  tradingBlocked: boolean;
  moneyAtRisk: boolean;
  mode: string;
  userAttentionRequired: boolean;
  rootCause: string;
  evidence: Record<string, unknown>;
  actionsTaken: string[];
  recoveryResult: string;
  followUpRecommendation: string;
  tags: string[];
  createdAt: string;
  resolvedAt: string | null;
  updatedAt: string;
  label: string;
}

export interface UseOpsTimelineResult {
  entries: OpsTimelineEntry[];
  loading: boolean;
  error: string | null;
  /** Open (unresolved) incidents that are currently blocking trading */
  openTradingBlockers: OpsTimelineEntry[];
  /** Count of entries requiring operator attention */
  attentionCount: number;
  /** Advance the ops_review_status on an incident. Metadata-only — never mutates trading state. */
  updateOpsStatus: (incidentId: string, newStatus: OpsReviewStatus) => Promise<void>;
  refetch: () => void;
}

// ─── Safe event types to surface ─────────────────────────────────────────────

const OPS_EVENT_TYPES = [
  "AI_GUARD_REJECTED",
  "AI_GUARD_FALLBACK",
  "kill_switch_on",
  "kill_switch_off",
  "state_changed",
  "bot_paused",
  "bot_resumed",
  "autonomy_changed",
] as const;

// ─── Mappers ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapIncidentRow(r: any): OpsTimelineEntry {
  const severityMap: Record<string, IncidentSeverity> = {
    P1: "critical",
    P2: "warning",
    P3: "info",
    P4: "info",
  };
  const severity: IncidentSeverity = severityMap[r.severity] ?? "info";

  return {
    id: r.id,
    source: "incident",
    sourceId: r.id,
    humanId: r.incident_id ?? r.id,
    severity,
    opsStatus: (r.ops_review_status ?? "detected") as OpsReviewStatus,
    hallStatus: r.status ?? "open",
    sourceEventType: r.source_event_type ?? null,
    affectedWorkflow: (r.affected_workflow ?? "ops") as AffectedWorkflow,
    affectedAgent: r.affected_agent ?? "unknown",
    tradingBlocked: r.trading_blocked ?? false,
    moneyAtRisk: r.money_at_risk ?? false,
    mode: r.paper_or_live_mode ?? "unknown",
    userAttentionRequired: r.user_attention_required ?? false,
    rootCause: r.root_cause ?? "",
    evidence: (r.evidence as Record<string, unknown>) ?? {},
    actionsTaken: r.actions_taken ?? [],
    recoveryResult: r.recovery_result ?? "",
    followUpRecommendation: r.follow_up_recommendation ?? "",
    tags: r.symptoms ?? [],
    createdAt: r.detected_at,
    resolvedAt: r.resolved_at ?? null,
    updatedAt: r.updated_at ?? r.detected_at,
    label: r.source_event_type ?? `Incident ${r.incident_id ?? r.id}`,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSystemEventRow(r: any): OpsTimelineEntry {
  const payload = (r.payload as Record<string, unknown>) ?? {};
  const surface = (payload["surface"] as string | undefined) ?? r.actor ?? "unknown";
  const mode = (payload["mode"] as string | undefined) ?? "unknown";

  const classification = classifyEventType({
    eventType: r.event_type,
    surface,
    mode: mode as "paper" | "live" | "unknown",
    payload,
  });

  return {
    id: r.id,
    source: "system_event",
    sourceId: r.id,
    humanId: `sys_${(r.id as string).slice(0, 8)}`,
    severity: classification.severity,
    opsStatus: "detected",
    hallStatus: "open",
    sourceEventType: r.event_type,
    affectedWorkflow: classification.affectedWorkflow,
    affectedAgent: r.actor ?? "system",
    tradingBlocked: classification.tradingBlocked,
    moneyAtRisk: classification.moneyAtRisk,
    mode: mode === "live" ? "live" : mode === "paper" ? "paper" : "unknown",
    userAttentionRequired: classification.userAttentionRequired,
    rootCause: classification.rootCause,
    // Only expose known-safe fields from payload — never raw AI output
    evidence: {
      surface: payload["surface"],
      decisionType: payload["decisionType"],
      validationStatus: payload["validationStatus"],
      unsafeIntentCount: payload["unsafeIntentCount"],
      protectedActionCount: payload["protectedActionCount"],
      actor: r.actor,
    },
    actionsTaken: [],
    recoveryResult: "",
    followUpRecommendation: "",
    tags: [r.event_type],
    createdAt: r.created_at,
    resolvedAt: null,
    updatedAt: r.created_at,
    label: classification.label,
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useOpsTimeline(): UseOpsTimelineResult {
  const { user } = useAuth();
  const [entries, setEntries] = useState<OpsTimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }

    try {
      // Fetch incidents and system_events in parallel
      const [incidentRes, eventRes] = await Promise.all([
        (supabase as any)
          .from("incidents")
          .select(
            "id,incident_id,severity,status,ops_review_status,source_event_type," +
            "affected_workflow,affected_agent,affected_system,trading_blocked," +
            "money_at_risk,paper_or_live_mode,user_attention_required,root_cause," +
            "evidence,actions_taken,recovery_result,follow_up_recommendation," +
            "symptoms,detected_at,resolved_at,updated_at"
          )
          .eq("user_id", user.id)
          .order("detected_at", { ascending: false })
          .limit(50),

        supabase
          .from("system_events")
          .select("id,event_type,actor,payload,created_at")
          .eq("user_id", user.id)
          .in("event_type", [...OPS_EVENT_TYPES])
          .order("created_at", { ascending: false })
          .limit(50),
      ]);

      if (incidentRes.error) throw incidentRes.error;
      if (eventRes.error) throw eventRes.error;

      const incidentEntries = (incidentRes.data ?? []).map(mapIncidentRow);
      const eventEntries = (eventRes.data ?? []).map(mapSystemEventRow);

      // Merge and sort newest first
      const merged = [...incidentEntries, ...eventEntries].sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
      );

      setEntries(merged);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load ops timeline");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useTableChanges("incidents", refetch);
  useTableChanges("system_events", refetch);

  // ── Update actions — metadata only ───────────────────────────────────────
  // This function ONLY updates ops_review_status on the incidents table.
  // It cannot affect: trading state, doctrine, strategies, signals, broker.

  const updateOpsStatus = useCallback(
    async (incidentId: string, newStatus: OpsReviewStatus): Promise<void> => {
      if (!user) throw new Error("Not signed in");

      const { error: rpcError } = await (supabase as any).rpc("update_incident_ops_status", {
        p_incident_id: incidentId,
        p_ops_status: newStatus,
      });

      if (rpcError) throw rpcError;

      // Optimistic local update
      setEntries((prev) =>
        prev.map((e) =>
          e.id === incidentId ? { ...e, opsStatus: newStatus } : e
        )
      );
    },
    [user]
  );

  // ── Derived values ───────────────────────────────────────────────────────

  const openTradingBlockers = entries.filter(
    (e) => e.tradingBlocked && e.opsStatus !== "resolved"
  );

  const attentionCount = entries.filter(
    (e) => e.userAttentionRequired && e.opsStatus !== "resolved"
  ).length;

  return {
    entries,
    loading,
    error,
    openTradingBlockers,
    attentionCount,
    updateOpsStatus,
    refetch,
  };
}
