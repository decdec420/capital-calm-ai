// ============================================================
// OpsTimeline — Hall/Ops Incident Timeline Panel
// ------------------------------------------------------------
// Displays a structured, operator-grade timeline of:
//   - Hall infrastructure incidents
//   - AI guard rejections and fallbacks
//   - Kill-switch state changes
//   - Bot pauses, autonomy changes, state changes
//
// Answers for Hall/Bobby/Wags:
//   - What failed? When? Which workflow? Trading blocked?
//   - Paper or live? Money at risk? User action needed?
//   - Recovery status? What was done?
//
// Read-only status update actions only mutate ops_review_status.
// They cannot affect trading behavior, doctrine, or signals.
// ============================================================

import { cn } from "@/lib/utils";
import { useOpsTimeline } from "@/hooks/useOpsTimeline";
import type { OpsTimelineEntry } from "@/hooks/useOpsTimeline";
import {
  type OpsReviewStatus,
  OPS_STATUS_LABEL,
  WORKFLOW_LABEL,
} from "@/lib/incident-classification";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  ShieldAlert,
  Wifi,
  XCircle,
  Info,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";

// ─── Severity badge ───────────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: OpsTimelineEntry["severity"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded",
        severity === "critical" && "bg-status-blocked/15 text-status-blocked border border-status-blocked/30",
        severity === "warning"  && "bg-status-caution/15 text-status-caution border border-status-caution/30",
        severity === "info"     && "bg-muted text-muted-foreground border border-border",
      )}
    >
      {severity === "critical" && <XCircle className="h-2.5 w-2.5" />}
      {severity === "warning"  && <AlertTriangle className="h-2.5 w-2.5" />}
      {severity === "info"     && <Info className="h-2.5 w-2.5" />}
      {severity}
    </span>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: OpsReviewStatus }) {
  const isResolved = status === "resolved" || status === "verified";
  return (
    <span
      className={cn(
        "inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded border",
        isResolved
          ? "bg-status-safe/10 text-status-safe border-status-safe/30"
          : "bg-secondary text-muted-foreground border-border",
      )}
    >
      {isResolved && <CheckCircle2 className="h-2.5 w-2.5 mr-1" />}
      {OPS_STATUS_LABEL[status]}
    </span>
  );
}

// ─── Timeline entry card ──────────────────────────────────────────────────────

const NEXT_STATUS: Partial<Record<OpsReviewStatus, OpsReviewStatus>> = {
  detected:     "diagnosed",
  diagnosed:    "action_taken",
  action_taken: "verified",
  verified:     "resolved",
};

function EntryCard({
  entry,
  onAdvance,
  onReviewSoftExit,
  advancing,
}: {
  entry: OpsTimelineEntry;
  onAdvance: (id: string, status: OpsReviewStatus) => void;
  onReviewSoftExit: (id: string, action: "acknowledge" | "mark_reviewed" | "dismiss") => void;
  advancing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const nextStatus = NEXT_STATUS[entry.opsStatus];
  const isResolved = entry.opsStatus === "resolved";

  const borderColor =
    entry.severity === "critical"
      ? "border-status-blocked/30"
      : entry.severity === "warning"
        ? "border-status-caution/30"
        : "border-border/50";

  const bgColor =
    entry.severity === "critical"
      ? "bg-status-blocked/5"
      : entry.severity === "warning"
        ? "bg-status-caution/5"
        : "";

  return (
    <div className={cn("rounded-md border px-3 py-2.5", borderColor, bgColor)}>
      {/* Row 1: severity + label + status */}
      <div className="flex items-start gap-2 justify-between">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <SeverityBadge severity={entry.severity} />
          <span className="text-xs font-semibold truncate">{entry.label}</span>
          {entry.tradingBlocked && !isResolved && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-status-blocked/15 text-status-blocked border border-status-blocked/30">
              <ShieldAlert className="h-2.5 w-2.5" />
              Trading Blocked
            </span>
          )}
          {entry.moneyAtRisk && !isResolved && (
            <span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded bg-status-caution/15 text-status-caution border border-status-caution/30">
              $ At Risk
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <StatusBadge status={entry.opsStatus} />
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded((o) => !o)}
            aria-label="Toggle detail"
          >
            {expanded
              ? <ChevronUp className="h-3.5 w-3.5" />
              : <ChevronDown className="h-3.5 w-3.5" />
            }
          </button>
        </div>
      </div>

      {/* Row 2: meta strip */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-2.5 w-2.5" />
          {new Date(entry.createdAt).toLocaleString()}
        </span>
        <span className="flex items-center gap-1">
          <Activity className="h-2.5 w-2.5" />
          {WORKFLOW_LABEL[entry.affectedWorkflow]}
        </span>
        <span className="flex items-center gap-1">
          <Wifi className="h-2.5 w-2.5" />
          {entry.mode === "live" ? "Live" : entry.mode === "paper" ? "Paper" : "—"}
        </span>
        {entry.source === "incident" && (
          <span className="font-mono opacity-60">{entry.humanId}</span>
        )}
      </div>

      {entry.source === "soft_exit_simulation" && (
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[10px]">
          <div><span className="text-muted-foreground">Trade</span> <span className="font-mono">{String(entry.evidence.tradeId ?? "—").slice(0, 8)}</span></div>
          <div><span className="text-muted-foreground">Side</span> <span className="font-mono">{String(entry.evidence.side ?? "—")}</span></div>
          <div><span className="text-muted-foreground">Entry</span> <span className="font-mono">{String(entry.evidence.entryRegime ?? "unknown")}</span></div>
          <div><span className="text-muted-foreground">Current</span> <span className="font-mono">{String(entry.evidence.currentRegime ?? "unknown")}</span></div>
          <div><span className="text-muted-foreground">Action</span> <span className="font-mono">{String(entry.evidence.simulatedActions ?? "NO_ACTION")}</span></div>
          <div><span className="text-muted-foreground">Result</span> <span className="font-mono">{String(entry.evidence.resultLabel ?? "simulation_only")}</span></div>
          <div><span className="text-muted-foreground">Allowed</span> <span className="font-mono">executionAllowed: false</span></div>
          <div><span className="text-muted-foreground">Review</span> <span className="font-mono">{entry.softExitReviewStatus ?? "unreviewed"}</span></div>
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div className="mt-2.5 space-y-1.5 border-t border-border/40 pt-2">
          {entry.rootCause && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Root cause</div>
              <p className="text-xs leading-relaxed">{entry.rootCause}</p>
            </div>
          )}

          {entry.actionsTaken.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Actions taken</div>
              <ul className="text-xs space-y-0.5 list-disc list-inside">
                {entry.actionsTaken.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          )}

          {entry.recoveryResult && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Recovery result</div>
              <p className="text-xs">{entry.recoveryResult}</p>
            </div>
          )}

          {entry.followUpRecommendation && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Follow-up</div>
              <p className="text-xs">{entry.followUpRecommendation}</p>
            </div>
          )}

          {/* Safe evidence fields only */}
          {Object.keys(entry.evidence).some((k) => entry.evidence[k] != null) && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Evidence</div>
              <div className="font-mono text-[10px] bg-secondary/50 rounded p-1.5 space-y-0.5">
                {Object.entries(entry.evidence)
                  .filter(([, v]) => v != null)
                  .map(([k, v]) => (
                    <div key={k}>
                      <span className="text-muted-foreground">{k}: </span>
                      <span>{String(v)}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Advance status — metadata-only action */}
          {entry.source === "incident" && !isResolved && nextStatus && (
            <div className="pt-1">
              <button
                className={cn(
                  "text-[10px] font-medium px-2.5 py-1 rounded border",
                  "bg-secondary hover:bg-secondary/80 border-border",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                  "flex items-center gap-1.5",
                )}
                disabled={advancing}
                onClick={() => onAdvance(entry.id, nextStatus)}
              >
                {advancing && <RefreshCw className="h-2.5 w-2.5 animate-spin" />}
                Mark as {OPS_STATUS_LABEL[nextStatus]}
              </button>
              <p className="text-[9px] text-muted-foreground mt-0.5">
                Updates review status only — no trading changes.
              </p>
            </div>
          )}

          {entry.source === "soft_exit_simulation" && entry.softExitReviewStatus !== "reviewed" && entry.softExitReviewStatus !== "dismissed" && (
            <div className="pt-1 space-y-1">
              <div className="flex flex-wrap gap-1.5">
                {[
                  ["acknowledge", "Acknowledge"],
                  ["mark_reviewed", "Mark reviewed"],
                  ["dismiss", "Dismiss"],
                ].map(([action, label]) => (
                  <button
                    key={action}
                    className={cn(
                      "text-[10px] font-medium px-2.5 py-1 rounded border",
                      "bg-secondary hover:bg-secondary/80 border-border",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                      "flex items-center gap-1.5",
                    )}
                    disabled={advancing}
                    onClick={() => onReviewSoftExit(entry.id, action as "acknowledge" | "mark_reviewed" | "dismiss")}
                  >
                    {advancing && <RefreshCw className="h-2.5 w-2.5 animate-spin" />}
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-[9px] text-muted-foreground mt-0.5">
                Review updates metadata only — no trade closes, stop changes, take-profit changes, or broker action.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

type FilterSeverity = "all" | "critical" | "warning" | "info";

export function OpsTimeline() {
  const { entries, loading, error, openTradingBlockers, attentionCount, updateOpsStatus, reviewSoftExitSimulation } =
    useOpsTimeline();

  const [filter, setFilter] = useState<FilterSeverity>("all");
  const [showResolved, setShowResolved] = useState(false);
  const [advancingId, setAdvancingId] = useState<string | null>(null);

  const handleAdvance = async (id: string, status: OpsReviewStatus) => {
    setAdvancingId(id);
    try {
      await updateOpsStatus(id, status);
    } catch (e) {
      console.error("[OpsTimeline] updateOpsStatus failed:", e);
    } finally {
      setAdvancingId(null);
    }
  };

  const handleSoftExitReview = async (id: string, action: "acknowledge" | "mark_reviewed" | "dismiss") => {
    setAdvancingId(id);
    try {
      await reviewSoftExitSimulation(id, action);
    } catch (e) {
      console.error("[OpsTimeline] reviewSoftExitSimulation failed:", e);
    } finally {
      setAdvancingId(null);
    }
  };

  const visible = entries.filter((e) => {
    if (!showResolved && e.opsStatus === "resolved") return false;
    if (filter !== "all" && e.severity !== filter) return false;
    return true;
  });

  const hasCritical = entries.some(
    (e) => e.severity === "critical" && e.opsStatus !== "resolved"
  );

  return (
    <div className="panel p-4 space-y-3 animate-fade-in">
      {/* Header */}
      <div className="flex items-start gap-2.5">
        <div className={cn("mt-0.5 shrink-0", hasCritical ? "text-status-blocked" : "text-muted-foreground")}>
          {hasCritical
            ? <XCircle className="h-4 w-4" />
            : <CheckCircle2 className="h-4 w-4" />
          }
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
            Hall / Ops Timeline
          </div>
          <div className="text-sm font-semibold leading-snug">
            {loading
              ? "Loading…"
              : hasCritical
                ? `${entries.filter((e) => e.severity === "critical" && e.opsStatus !== "resolved").length} critical incident${entries.filter((e) => e.severity === "critical" && e.opsStatus !== "resolved").length !== 1 ? "s" : ""} open`
                : attentionCount > 0
                  ? `${attentionCount} item${attentionCount !== 1 ? "s" : ""} need attention`
                  : "Ops clear"
            }
          </div>
        </div>
        {openTradingBlockers.length > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-status-blocked/15 text-status-blocked border border-status-blocked/30 shrink-0">
            <ShieldAlert className="h-2.5 w-2.5" />
            {openTradingBlockers.length} blocking
          </span>
        )}
      </div>

      {error && (
        <div className="text-xs text-status-blocked bg-status-blocked/10 rounded px-2 py-1.5">
          Failed to load timeline: {error}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-1.5 items-center">
        {(["all", "critical", "warning", "info"] as FilterSeverity[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded border",
              filter === f
                ? "bg-primary/10 text-primary border-primary/30"
                : "bg-secondary text-muted-foreground border-border hover:bg-secondary/80",
            )}
          >
            {f}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
            className="h-3 w-3 rounded"
          />
          Show resolved
        </label>
      </div>

      {/* Timeline entries */}
      {loading && entries.length === 0 ? (
        <div className="space-y-2 animate-pulse">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-muted rounded" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="text-xs text-muted-foreground text-center py-4">
          {entries.length === 0 ? "No incidents recorded." : "No items match current filter."}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((entry) => (
            <EntryCard
              key={`${entry.source}-${entry.id}`}
              entry={entry}
              onAdvance={handleAdvance}
              onReviewSoftExit={handleSoftExitReview}
              advancing={advancingId === entry.id}
            />
          ))}
        </div>
      )}

      {/* Footer note */}
      <div className="border-t border-border/50 pt-2 text-[9px] text-muted-foreground leading-relaxed">
        Timeline shows Hall infrastructure incidents and operational system events (newest first).
        Status updates are metadata-only and do not affect trading behavior.
      </div>
    </div>
  );
}
