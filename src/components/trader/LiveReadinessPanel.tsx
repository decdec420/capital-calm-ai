// ============================================================
// LiveReadinessPanel — Live-Readiness / Broker-Permission Audit
// ------------------------------------------------------------
// This panel does not enable live trading.
// It only audits readiness and safety blockers.
//
// Reads from useTradingDecisionSnapshot + useBrokerHealth.
// Pure display — no mutations, no broker execution, no trade creation.
// ============================================================

import { cn } from "@/lib/utils";
import { useTradingDecisionSnapshot } from "@/hooks/useTradingDecisionSnapshot";
import { useBrokerHealth } from "@/hooks/useBrokerHealth";
import { computeLiveReadiness } from "@/lib/live-readiness";
import type { ReadinessCheck, BrokerPermissionSummary, LiveReadinessStatus } from "@/lib/live-readiness";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  Info,
  Lock,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useState } from "react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function CheckIcon({ status }: { status: ReadinessCheck["status"] }) {
  if (status === "pass")
    return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-status-safe" />;
  if (status === "warn")
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-status-caution" />;
  if (status === "fail")
    return <XCircle className="h-3.5 w-3.5 shrink-0 text-status-blocked" />;
  return <HelpCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />;
}

function statusDot(status: ReadinessCheck["status"]) {
  if (status === "pass") return "bg-status-safe";
  if (status === "warn") return "bg-status-caution";
  if (status === "fail") return "bg-status-blocked";
  return "bg-muted-foreground/30";
}

function overallTone(status: LiveReadinessStatus) {
  if (status === "not_ready") return "text-status-blocked";
  if (status === "paper_only_ready") return "text-status-caution";
  if (status === "live_ready_blocked") return "text-status-caution";
  return "text-status-safe";
}

function overallLabel(status: LiveReadinessStatus) {
  if (status === "not_ready") return "Not ready";
  if (status === "paper_only_ready") return "Paper only";
  if (status === "live_ready_blocked") return "Live blocked";
  return "Checks passed";
}

function overallIcon(status: LiveReadinessStatus) {
  if (status === "not_ready")
    return <ShieldAlert className="h-5 w-5 text-status-blocked" />;
  if (status === "live_ready_blocked" || status === "paper_only_ready")
    return <AlertTriangle className="h-5 w-5 text-status-caution" />;
  return <ShieldCheck className="h-5 w-5 text-status-safe" />;
}

// ─── Single check row ─────────────────────────────────────────────────────────

function CheckRow({ item, expanded }: { item: ReadinessCheck; expanded: boolean }) {
  return (
    <div
      className={cn(
        "border-l-2 pl-3 py-1.5 space-y-0.5",
        item.status === "fail" && "border-status-blocked/60",
        item.status === "warn" && "border-status-caution/60",
        item.status === "pass" && "border-status-safe/30",
        item.status === "unknown" && "border-muted-foreground/20",
      )}
    >
      <div className="flex items-start gap-2">
        <CheckIcon status={item.status} />
        <span className="text-xs font-medium text-foreground leading-snug">{item.label}</span>
      </div>
      {expanded && (
        <div className="space-y-1 pl-5">
          <p className="text-[11px] text-muted-foreground leading-snug">{item.explanation}</p>
          {(item.status === "fail" || item.status === "warn") && (
            <p className="text-[11px] text-primary leading-snug">
              <span className="font-medium">Action: </span>{item.safeAction}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Broker permission summary row ───────────────────────────────────────────

function PermissionRow({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: string;
  tone: "safe" | "blocked" | "caution" | "neutral";
  detail?: string;
}) {
  const toneClass =
    tone === "safe" ? "text-status-safe"
    : tone === "blocked" ? "text-status-blocked"
    : tone === "caution" ? "text-status-caution"
    : "text-muted-foreground";

  return (
    <div className="flex items-center justify-between py-1 border-b border-border/30 last:border-0">
      <div className="space-y-0.5">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        {detail && <p className="text-[10px] text-muted-foreground/60">{detail}</p>}
      </div>
      <span className={cn("text-xs font-medium tabular", toneClass)}>{value}</span>
    </div>
  );
}

function BrokerPermissionsBlock({ summary }: { summary: BrokerPermissionSummary }) {
  const transferTone =
    summary.transferPermission === "detected" ? "blocked"
    : summary.transferPermission === "absent" ? "safe"
    : "neutral" as const;

  const transferValue =
    summary.transferPermission === "detected" ? "DETECTED — critical fail"
    : summary.transferPermission === "absent" ? "Not present (safe)"
    : "Unknown";

  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
        Coinbase API Permissions
      </p>
      {summary.transferPermission === "detected" && (
        <div className="rounded border border-status-blocked/40 bg-status-blocked/10 p-2 mb-2">
          <p className="text-[11px] text-status-blocked font-medium">
            Transfer permission is not allowed. Remove it before any live-readiness review.
          </p>
        </div>
      )}
      <PermissionRow
        label="Transfer permission"
        value={transferValue}
        tone={transferTone}
        detail="Must always be absent — prevents withdrawal risk"
      />
      <PermissionRow
        label="View (read-only)"
        value={
          summary.viewPermission === "pass" ? "Present"
          : summary.viewPermission === "fail" ? "Missing"
          : "Unknown"
        }
        tone={
          summary.viewPermission === "pass" ? "safe"
          : summary.viewPermission === "fail" ? "caution"
          : "neutral"
        }
        detail="Required for account health/equity checks"
      />
      <PermissionRow
        label="Trade permission"
        value={
          summary.tradePermission === "present" ? "Present"
          : summary.tradePermission === "absent" ? "Not present"
          : "Unknown"
        }
        tone={
          summary.tradePermission === "present"
            ? "caution" // warn: present, but we haven't armed live mode intentionally
            : "neutral"
        }
        detail="Not required for paper mode. May be needed for live mode only."
      />
      <PermissionRow
        label="Broker auth"
        value={summary.authHealthy ? "Healthy" : "Not connected"}
        tone={summary.authHealthy ? "safe" : "neutral"}
      />
      {summary.keyName && (
        <PermissionRow
          label="API key"
          value={summary.keyName}
          tone="neutral"
          detail="Key name only — key value is never shown"
        />
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function LiveReadinessPanel() {
  const { snapshot, loading } = useTradingDecisionSnapshot();
  const { health: brokerHealth, loading: brokerLoading } = useBrokerHealth();
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const report = computeLiveReadiness({ snapshot, brokerHealth });

  const passChecks = report.checks.filter((c) => c.status === "pass");
  const visibleChecks = showAll
    ? report.checks
    : report.checks.filter((c) => c.status !== "pass");
  const hasHiddenPasses = passChecks.length > 0 && !showAll;

  const isLoading = loading || brokerLoading;

  return (
    <div className="panel p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <div>
            <span className="text-sm font-semibold text-foreground">
              Live Readiness / Broker Permissions
            </span>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              This panel does not enable live trading. It only audits readiness and safety blockers.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {/* Overall status strip */}
      <div className="grid grid-cols-3 gap-2">
        {/* Paper */}
        <div className="rounded border border-border/50 bg-secondary/30 p-2.5 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Paper</div>
          <div className={cn("flex items-center gap-1.5", report.paperReady ? "text-status-safe" : "text-status-blocked")}>
            <span className={cn("inline-block h-1.5 w-1.5 rounded-full shrink-0", statusDot(report.paperReady ? "pass" : "fail"))} />
            <span className="text-xs font-medium">{report.paperReady ? "Ready" : "Blocked"}</span>
          </div>
        </div>
        {/* Live */}
        <div className="rounded border border-border/50 bg-secondary/30 p-2.5 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Live</div>
          <div className={cn("flex items-center gap-1.5", report.liveReady ? "text-status-safe" : "text-status-caution")}>
            <span className={cn("inline-block h-1.5 w-1.5 rounded-full shrink-0", statusDot(report.liveReady ? "pass" : "warn"))} />
            <span className="text-xs font-medium">{report.liveReady ? "Possible" : "Blocked"}</span>
          </div>
        </div>
        {/* Overall */}
        <div className="rounded border border-border/50 bg-secondary/30 p-2.5 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Overall</div>
          <div className={cn("flex items-center gap-1.5", overallTone(report.overallStatus))}>
            {overallIcon(report.overallStatus)}
            <span className="text-xs font-medium">{overallLabel(report.overallStatus)}</span>
          </div>
        </div>
      </div>

      {/* Blockers summary */}
      {report.blockers.length > 0 && (
        <div className="rounded border border-status-blocked/30 bg-status-blocked/5 p-2.5 space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-status-blocked font-semibold">
            {report.blockers.length} blocker{report.blockers.length !== 1 ? "s" : ""}
          </p>
          <p className="text-[11px] text-muted-foreground">{report.nextSafeAction}</p>
        </div>
      )}

      {/* Broker permissions (always visible) */}
      <BrokerPermissionsBlock summary={report.brokerPermissionSummary} />

      {/* Expandable checks */}
      {expanded && (
        <div className="space-y-3 pt-1 border-t border-border/30">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Readiness Checks ({report.checks.length})
            </p>
            <div className="flex items-center gap-2 text-[10px]">
              {isLoading && (
                <span className="text-muted-foreground/60 italic">loading…</span>
              )}
              {report.blockers.length > 0 && (
                <span className="text-status-blocked">{report.blockers.length} fail</span>
              )}
              {report.warnings.length > 0 && (
                <span className="text-status-caution">{report.warnings.length} warn</span>
              )}
              <span className="text-status-safe">{passChecks.length} pass</span>
            </div>
          </div>

          {/* Fail / warn checks always shown first */}
          {(report.blockers.length > 0 || report.warnings.length > 0) && (
            <div className="space-y-1.5">
              {report.blockers.map((c) => (
                <CheckRow key={c.id} item={c} expanded />
              ))}
              {report.warnings.map((c) => (
                <CheckRow key={c.id} item={c} expanded />
              ))}
            </div>
          )}

          {/* Show-all toggle for passing checks */}
          {passChecks.length > 0 && (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => setShowAll((s) => !s)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <Info className="h-3 w-3" />
                {showAll ? "Hide passing checks" : `Show ${passChecks.length} passing check${passChecks.length !== 1 ? "s" : ""}`}
              </button>
              {showAll && passChecks.map((c) => (
                <CheckRow key={c.id} item={c} expanded={false} />
              ))}
            </div>
          )}

          {/* Safety notice */}
          <div className="rounded border border-border/30 bg-secondary/20 p-2.5 space-y-1">
            <div className="flex items-start gap-1.5">
              <Lock className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Safety notice
                </p>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Paper mode should work without Coinbase Trade permission.
                  For Transfer permission: Transfer permission is not allowed. Remove it before any live-readiness review.
                  These checks do not create trades, approve signals, change doctrine, or modify strategies.
                </p>
              </div>
            </div>
          </div>

          <p className="text-[10px] text-muted-foreground/50 text-right">
            audited {new Date(report.computedAt).toLocaleTimeString()}
          </p>
        </div>
      )}

      {/* Expand prompt when collapsed */}
      {!expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-[11px] text-primary hover:underline"
        >
          View all {report.checks.length} readiness checks →
        </button>
      )}
    </div>
  );
}
