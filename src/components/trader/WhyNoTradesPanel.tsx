// ============================================================
// WhyNoTradesPanel — Full "Why No Trades?" Diagnostic
// ------------------------------------------------------------
// Uses useTradingDecisionSnapshot() exclusively — no local guesses.
// Every data point derives from the canonical snapshot or live hooks.
//
// Place below <NextBestAction /> in Overview right column.
// ============================================================

import { cn } from "@/lib/utils";
import { useTradingDecisionSnapshot } from "@/hooks/useTradingDecisionSnapshot";
import { useRelativeTime } from "@/hooks/useRelativeTime";
import {
  Activity,
  AlertTriangle,
  Bot,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Database,
  Shield,
  ShieldAlert,
  Wifi,
  XCircle,
  Zap,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { BlockerEntry } from "@/lib/trading-decision-snapshot";

// ─── helpers ─────────────────────────────────────────────────────────────────

function StatusDot({ ok, unknown }: { ok: boolean; unknown?: boolean }) {
  if (unknown) return <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/30" />;
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full shrink-0",
        ok ? "bg-status-safe" : "bg-status-blocked",
      )}
    />
  );
}

function Row({
  icon,
  label,
  value,
  ok,
  unknown,
  linkTo,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  ok: boolean;
  unknown?: boolean;
  linkTo?: string;
}) {
  const content = (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-muted-foreground shrink-0">{icon}</span>
        <span className="text-xs text-muted-foreground truncate">{label}</span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={cn("text-xs font-medium", ok ? "text-status-safe" : unknown ? "text-muted-foreground" : "text-status-blocked")}>
          {value}
        </span>
        <StatusDot ok={ok} unknown={unknown} />
      </div>
    </div>
  );

  if (linkTo) {
    return <Link to={linkTo} className="block hover:bg-muted/50 rounded px-1 -mx-1">{content}</Link>;
  }
  return <div className="px-1 -mx-1">{content}</div>;
}

function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-border/50 first:border-t-0 pt-3 first:pt-0">
      <button
        className="flex items-center justify-between w-full text-left mb-1"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">{title}</span>
        {open ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
      </button>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
  );
}

// ─── blocker card ────────────────────────────────────────────────────────────

function BlockerCard({ blocker }: { blocker: BlockerEntry }) {
  const tone = blocker.severity === "critical" || blocker.severity === "high"
    ? "blocked"
    : "caution";
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 flex gap-2",
        tone === "blocked"
          ? "border-status-blocked/30 bg-status-blocked/5"
          : "border-status-caution/30 bg-status-caution/5",
      )}
    >
      <XCircle
        className={cn(
          "h-3.5 w-3.5 mt-0.5 shrink-0",
          tone === "blocked" ? "text-status-blocked" : "text-status-caution",
        )}
      />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium leading-snug">{blocker.message}</div>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          Owner: <span className="font-medium">{blocker.owner}</span>
          {" · "}
          {blocker.nextSafeAction}
        </div>
      </div>
    </div>
  );
}

// ─── component ────────────────────────────────────────────────────────────────

export function WhyNoTradesPanel() {
  const { snapshot, loading } = useTradingDecisionSnapshot();

  const taylorAge = useRelativeTime(
    snapshot?.taylorLastRanAt ? Date.parse(snapshot.taylorLastRanAt) : null,
  );
  const brainTrustAge = useRelativeTime(
    snapshot?.brainTrustLastAt ? Date.parse(snapshot.brainTrustLastAt) : null,
  );

  if (loading && !snapshot) {
    return (
      <div className="panel p-4 animate-pulse">
        <div className="h-4 bg-muted rounded w-1/2 mb-3" />
        <div className="space-y-2">
          <div className="h-3 bg-muted rounded w-3/4" />
          <div className="h-3 bg-muted rounded w-2/3" />
        </div>
      </div>
    );
  }

  if (!snapshot) return null;

  const { canTradeNow, blockers } = snapshot;
  const modeLabel = snapshot.mode === "unknown" ? "—" : snapshot.mode;

  return (
    <div className="panel p-4 space-y-3 animate-fade-in">
      {/* Header */}
      <div className="flex items-start gap-2.5">
        <div className={cn(
          "mt-0.5 shrink-0",
          canTradeNow ? "text-status-safe" : "text-status-blocked",
        )}>
          {canTradeNow ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <AlertTriangle className="h-4 w-4" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
            Why no trades?
          </div>
          <div className={cn("text-sm font-semibold leading-snug", canTradeNow ? "text-status-safe" : "text-foreground")}>
            {canTradeNow
              ? "Desk is clear — Taylor is scanning"
              : `${blockers.length} blocker${blockers.length !== 1 ? "s" : ""} preventing new trades`}
          </div>
        </div>
      </div>

      {/* Active blockers */}
      {blockers.length > 0 && (
        <div className="space-y-1.5">
          {blockers.map((b) => (
            <BlockerCard key={b.code} blocker={b} />
          ))}
        </div>
      )}

      <div className="space-y-3">
        {/* System section */}
        <Section title="System">
          <Row
            icon={<Bot className="h-3.5 w-3.5" />}
            label="Mode"
            value={modeLabel}
            ok={snapshot.mode === "paper" || snapshot.mode === "live"}
          />
          <Row
            icon={<Activity className="h-3.5 w-3.5" />}
            label="Bot"
            value={snapshot.botRunning ? "Running" : "Not running"}
            ok={snapshot.botRunning}
            linkTo="/"
          />
          <Row
            icon={<Shield className="h-3.5 w-3.5" />}
            label="Kill switch"
            value={snapshot.killSwitchEngaged ? "Engaged" : "Disarmed"}
            ok={!snapshot.killSwitchEngaged}
            linkTo="/risk"
          />
        </Section>

        {/* Signal engine section */}
        <Section title="Signal Engine (Taylor)">
          <Row
            icon={<Zap className="h-3.5 w-3.5" />}
            label="Last scan"
            value={snapshot.taylorLastRanAt ? taylorAge : "Never"}
            ok={snapshot.taylorFresh}
            unknown={!snapshot.taylorLastRanAt}
          />
          <Row
            icon={<Brain className="h-3.5 w-3.5" />}
            label="Brain Trust"
            value={snapshot.brainTrustLastAt ? brainTrustAge : "Never"}
            ok={snapshot.brainTrustFresh}
            unknown={!snapshot.brainTrustLastAt}
            linkTo="/market"
          />
          <Row
            icon={<Database className="h-3.5 w-3.5" />}
            label="Active strategies"
            value={
              snapshot.activeStrategyExists
                ? snapshot.activeStrategyNames.join(", ")
                : "None approved"
            }
            ok={snapshot.activeStrategyExists}
            linkTo="/strategy"
          />
        </Section>

        {/* Risk section */}
        <Section title="Risk Gates">
          <Row
            icon={<ShieldAlert className="h-3.5 w-3.5" />}
            label="Account floor"
            value={snapshot.accountFloorClear ? "Clear" : "Breached"}
            ok={snapshot.accountFloorClear}
            linkTo="/risk"
          />
          <Row
            icon={<Clock className="h-3.5 w-3.5" />}
            label="Daily loss cap"
            value={snapshot.dailyLossCapClear ? "Clear" : "Reached"}
            ok={snapshot.dailyLossCapClear}
            linkTo="/risk"
          />
          <Row
            icon={<Activity className="h-3.5 w-3.5" />}
            label="Daily trade cap"
            value={snapshot.maxTradesClear ? "Clear" : "Reached"}
            ok={snapshot.maxTradesClear}
            linkTo="/risk"
          />
          <Row
            icon={<Shield className="h-3.5 w-3.5" />}
            label="Doctrine overlay"
            value={snapshot.doctrineOverlayClear ? "Clear" : "Blocking entries"}
            ok={snapshot.doctrineOverlayClear}
            linkTo="/risk"
          />
        </Section>

        {/* Connectivity section */}
        <Section title="Connectivity" defaultOpen={false}>
          <Row
            icon={<Wifi className="h-3.5 w-3.5" />}
            label="Market data"
            value={snapshot.marketDataConnected ? "Connected" : "Disconnected"}
            ok={snapshot.marketDataConnected}
          />
          <Row
            icon={<Wifi className="h-3.5 w-3.5" />}
            label="Coinbase broker"
            value={snapshot.coinbaseBrokerHealthy ? "Connected" : "Not connected"}
            ok={snapshot.coinbaseBrokerHealthy}
            linkTo="/settings"
          />
        </Section>
      </div>

      {/* Next safe action */}
      <div className="border-t border-border/50 pt-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
          Next safe action
        </div>
        <p className="text-xs text-foreground leading-relaxed">{snapshot.nextSafeAction}</p>
      </div>
    </div>
  );
}
