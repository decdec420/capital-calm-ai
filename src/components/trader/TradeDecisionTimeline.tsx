// ─────────────────────────────────────────────────────────────────────────────
// P2: TradeDecisionTimeline.tsx
// New file → src/components/trader/TradeDecisionTimeline.tsx
//
// 9-step pipeline visualization: Market Data → Brain Trust → Taylor Signal →
// Strategy Match → Risk Gates → Proposal → Execution → PnL → Learning.
//
// States per step: done (green) | active (cyan pulse) | blocked (red) |
//                  stale (amber) | pending (gray)
//
// Usage (inline in Copilot.tsx, after the signal card):
//   import { TradeDecisionTimeline } from "@/components/trader/TradeDecisionTimeline";
//   <TradeDecisionTimeline signal={activeSignal} />
//
// Usage (drilldown from MetricCard — wrap in a sheet/dialog):
//   <TradeDecisionTimeline signal={null} showSystemHealth />
// ─────────────────────────────────────────────────────────────────────────────

import { cn } from "@/lib/utils";
import { useSystemState } from "@/hooks/useSystemState";
import { useTrades } from "@/hooks/useTrades";
import { useSignals } from "@/hooks/useSignals";
import { useExperiments } from "@/hooks/useExperiments";
import { isStale } from "@/hooks/useRelativeTime";
import type { TradeSignal } from "@/lib/domain-types";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Brain,
  CheckCircle2,
  Clock,
  DollarSign,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  WifiOff,
  XCircle,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";

// ─── step shape ───────────────────────────────────────────────────────────────

type StepState = "done" | "active" | "blocked" | "stale" | "pending";

interface PipelineStep {
  id: string;
  num: string;
  title: string;
  agent: string;
  detail: string;
  state: StepState;
  icon: ReactNode;
}

// ─── state styles ─────────────────────────────────────────────────────────────

const STATE_STYLES: Record<StepState, {
  border: string; bg: string; num: string; title: string; detail: string; icon: string;
}> = {
  done:    { border: "border-status-safe/40",    bg: "bg-status-safe/5",    num: "text-status-safe",    title: "text-foreground",      detail: "text-muted-foreground", icon: "text-status-safe"    },
  active:  { border: "border-primary/60",        bg: "bg-primary/8",        num: "text-primary",        title: "text-foreground",      detail: "text-primary/80",       icon: "text-primary"        },
  blocked: { border: "border-status-blocked/50", bg: "bg-status-blocked/8", num: "text-status-blocked", title: "text-status-blocked",  detail: "text-status-blocked/70",icon: "text-status-blocked" },
  stale:   { border: "border-status-caution/50", bg: "bg-status-caution/8", num: "text-status-caution", title: "text-foreground",      detail: "text-status-caution",   icon: "text-status-caution" },
  pending: { border: "border-border",            bg: "bg-card/30",          num: "text-muted-foreground/40", title: "text-muted-foreground/50", detail: "text-muted-foreground/40", icon: "text-muted-foreground/30" },
};

// ─── arrow ────────────────────────────────────────────────────────────────────

function Arrow({ blocked }: { blocked?: boolean }) {
  return (
    <div className="flex items-center justify-center w-5 shrink-0 self-center">
      <ArrowRight
        className={cn("h-3 w-3", blocked ? "text-status-blocked/40" : "text-muted-foreground/30")}
      />
    </div>
  );
}

// ─── step card ────────────────────────────────────────────────────────────────

function Step({ step, isLast }: { step: PipelineStep; isLast: boolean }) {
  const s = STATE_STYLES[step.state];

  return (
    <div className={cn("flex items-stretch gap-0 shrink-0")}>
      <div
        className={cn(
          "rounded-lg border px-3 py-2.5 flex flex-col gap-1 min-w-[110px] max-w-[140px]",
          s.border, s.bg,
          step.state === "active" && "shadow-[0_0_0_1px_hsl(var(--primary)/0.15)]",
        )}
      >
        {/* Step number */}
        <div className={cn("font-mono text-[9px] font-semibold tracking-wider", s.num)}>
          {step.num}
        </div>

        {/* Icon + title */}
        <div className="flex items-center gap-1.5">
          <span className={cn("shrink-0", s.icon)}>{step.icon}</span>
          <span className={cn("text-[11px] font-semibold leading-tight", s.title)}>
            {step.title}
          </span>
        </div>

        {/* Agent */}
        <div className="text-[9px] text-muted-foreground/50 uppercase tracking-wider leading-none">
          {step.agent}
        </div>

        {/* Detail */}
        <div className={cn("text-[10px] leading-snug", s.detail)}>
          {step.detail}
        </div>

        {/* Active pulse indicator */}
        {step.state === "active" && (
          <div className="flex items-center gap-1 mt-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-soft" />
            <span className="text-[9px] text-primary/70">in progress</span>
          </div>
        )}
      </div>
      {!isLast && <Arrow blocked={step.state === "blocked"} />}
    </div>
  );
}

// ─── component ────────────────────────────────────────────────────────────────

interface TradeDecisionTimelineProps {
  /** When provided, the timeline reflects this specific signal's journey.
   *  When null, shows the current system-level state (good for Overview drilldown). */
  signal?: TradeSignal | null;
  className?: string;
}

export function TradeDecisionTimeline({ signal, className }: TradeDecisionTimelineProps) {
  const { data: system } = useSystemState();
  const { open } = useTrades();
  const { pending: pendingSignals, history: signalHistory } = useSignals();
  const { counts: expCounts } = useExperiments();

  const snapshot = system?.lastEngineSnapshot ?? null;
  const gateReasons = snapshot?.gateReasons ?? [];
  const dataStale = isStale(snapshot ? new Date(snapshot.ranAt).getTime() : null);
  const hardBlock = gateReasons.find((r) => r.severity === "halt" || r.severity === "block");

  // The signal we're tracing — could be passed in or inferred
  const tracedSignal = signal ?? pendingSignals[0] ?? null;

  // Derive per-symbol snapshot for BTC-USD (or chosen symbol)
  const chosenSym = snapshot?.chosenSymbol ?? tracedSignal?.symbol ?? "BTC-USD";
  const symSnap = snapshot?.perSymbol.find((p) => p.symbol === chosenSym);

  // Has there been a completed (closed) trade from this signal?
  const executedTrade = tracedSignal?.executedTradeId
    ? open.find((t) => t.id === tracedSignal.executedTradeId) ??
      signalHistory?.find((s) => s.executedTradeId === tracedSignal.id) ?? null
    : null;

  // ── Build steps ─────────────────────────────────────────────────────────────

  const steps: PipelineStep[] = [

    // 01 Market Data
    {
      id: "data",
      num: "01",
      title: "Market Data",
      agent: "Hall · Feed",
      icon: <Activity className="h-3 w-3" />,
      state: !snapshot ? "pending" : dataStale ? "stale" : "done",
      detail: !snapshot
        ? "No snapshot"
        : dataStale
          ? "Data stale — check feed"
          : symSnap
            ? `${chosenSym} $${symSnap.lastPrice.toFixed(0)}`
            : "Feed connected",
    },

    // 02 Brain Trust
    {
      id: "brain",
      num: "02",
      title: "Brain Trust",
      agent: "Intelligence",
      icon: <Brain className="h-3 w-3" />,
      state: !symSnap ? "pending" : dataStale ? "stale" : "done",
      detail: symSnap
        ? `${symSnap.regime.replace(/_/g, " ")} · ${(symSnap.confidence * 100).toFixed(0)}% conf`
        : "No intel yet",
    },

    // 03 Taylor Signal
    {
      id: "taylor",
      num: "03",
      title: "Taylor Signal",
      agent: "Signal Analyst",
      icon: <Zap className="h-3 w-3" />,
      state: !tracedSignal
        ? "pending"
        : tracedSignal.status === "pending"
          ? "active"
          : "done",
      detail: tracedSignal
        ? `${tracedSignal.side.toUpperCase()} @ $${tracedSignal.proposedEntry.toFixed(0)} · ${(tracedSignal.confidence * 100).toFixed(0)}%`
        : gateReasons.some((r) => r.code === "STALE_DATA" || r.code === "AI_SKIP")
          ? "Skipped — see gates"
          : "No signal yet",
    },

    // 04 Strategy Match
    {
      id: "strategy",
      num: "04",
      title: "Strategy",
      agent: "Katrina",
      icon: <TrendingUp className="h-3 w-3" />,
      state: !tracedSignal
        ? "pending"
        : tracedSignal.strategyVersion
          ? "done"
          : "pending",
      detail: tracedSignal?.strategyVersion
        ? tracedSignal.strategyVersion
        : "Awaiting signal",
    },

    // 05 Risk Gates
    {
      id: "risk",
      num: "05",
      title: "Risk Gates",
      agent: "Risk / Compliance",
      icon: <ShieldAlert className="h-3 w-3" />,
      state: !tracedSignal
        ? hardBlock
          ? "blocked"
          : "pending"
        : tracedSignal.status === "rejected" && tracedSignal.decisionReason
          ? "blocked"
          : tracedSignal.status === "pending"
            ? hardBlock ? "blocked" : "active"
            : "done",
      detail: hardBlock
        ? hardBlock.message.slice(0, 45)
        : tracedSignal?.status === "pending"
          ? `${gateReasons.length === 0 ? "All gates pass" : `${gateReasons.length} gate${gateReasons.length > 1 ? "s" : ""} active`}`
          : "All gates passed",
    },

    // 06 Proposal
    {
      id: "proposal",
      num: "06",
      title: "Proposal",
      agent: "Wags → Bobby",
      icon: <Sparkles className="h-3 w-3" />,
      state: !tracedSignal
        ? "pending"
        : tracedSignal.status === "pending"
          ? "active"
          : tracedSignal.status === "rejected"
            ? "blocked"
            : "done",
      detail: !tracedSignal
        ? "None staged"
        : tracedSignal.status === "pending"
          ? "Awaiting your decision"
          : tracedSignal.status === "approved"
            ? "Approved"
            : tracedSignal.status === "rejected"
              ? `Rejected: ${tracedSignal.decisionReason ?? "no reason"}`
              : tracedSignal.status === "expired"
                ? "Expired"
                : "Executed",
    },

    // 07 Execution
    {
      id: "execution",
      num: "07",
      title: "Execution",
      agent: "Broker Gateway",
      icon: <DollarSign className="h-3 w-3" />,
      state: !tracedSignal || tracedSignal.status === "pending"
        ? "pending"
        : tracedSignal.status === "rejected" || tracedSignal.status === "expired"
          ? "blocked"
          : tracedSignal.executedTradeId
            ? "done"
            : "active",
      detail: tracedSignal?.executedTradeId
        ? "Order placed"
        : tracedSignal?.status === "approved"
          ? "Processing…"
          : "—",
    },

    // 08 PnL
    {
      id: "pnl",
      num: "08",
      title: "PnL",
      agent: "Mark-to-Market",
      icon: <TrendingUp className="h-3 w-3" />,
      state: executedTrade
        ? executedTrade.unrealizedPnl !== null || executedTrade.pnl !== null
          ? "done"
          : "active"
        : "pending",
      detail: executedTrade
        ? executedTrade.pnl !== null
          ? `${executedTrade.pnl >= 0 ? "+" : ""}$${executedTrade.pnl.toFixed(4)}`
          : executedTrade.unrealizedPnl !== null
            ? `Live: ${executedTrade.unrealizedPnl >= 0 ? "+" : ""}$${executedTrade.unrealizedPnl.toFixed(4)}`
            : "Open"
        : "—",
    },

    // 09 Learning
    {
      id: "learning",
      num: "09",
      title: "Learning",
      agent: "Wendy",
      icon: <BookOpen className="h-3 w-3" />,
      state: expCounts.total > 0
        ? expCounts.needsReview > 0
          ? "active"
          : "done"
        : "pending",
      detail: expCounts.needsReview > 0
        ? `${expCounts.needsReview} to review`
        : expCounts.total > 0
          ? "Lessons logged"
          : "No experiments yet",
    },
  ];

  return (
    <div className={cn("space-y-2", className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Trade decision pipeline
          </div>
          {tracedSignal && (
            <div className="text-xs text-muted-foreground/60 mt-0.5 font-mono">
              Signal #{tracedSignal.id.slice(-8)} · {tracedSignal.symbol} · {tracedSignal.side.toUpperCase()}
            </div>
          )}
        </div>
        {/* Legend */}
        <div className="flex items-center gap-3 text-[9px] uppercase tracking-wider">
          {(["done", "active", "blocked", "stale", "pending"] as StepState[]).map((s) => (
            <span key={s} className={cn("flex items-center gap-1", STATE_STYLES[s].detail)}>
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  s === "done"    && "bg-status-safe",
                  s === "active"  && "bg-primary",
                  s === "blocked" && "bg-status-blocked",
                  s === "stale"   && "bg-status-caution",
                  s === "pending" && "bg-muted-foreground/30",
                )}
              />
              {s}
            </span>
          ))}
        </div>
      </div>

      {/* Pipeline scroll */}
      <div className="flex overflow-x-auto pb-2 gap-0">
        {steps.map((step, i) => (
          <Step key={step.id} step={step} isLast={i === steps.length - 1} />
        ))}
      </div>
    </div>
  );
}
