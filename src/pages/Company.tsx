// ─────────────────────────────────────────────────────────────────────────────
// P2: Company.tsx
// New file → src/pages/Company.tsx
//
// Route: /company (add to App.tsx — see wiring instructions below)
//
// The AI trading company roster. Each agent shown as a card with:
//   name · role · department · status dot · authority list · last action · link
//
// Add to App.tsx:
//   import Company from "./pages/Company";
//   // Inside the AppLayout route group:
//   <Route path="/company" element={<Company />} />
//
// Add to AppSidebar.tsx (under Command Center group):
//   { title: "Company", url: "/company", icon: Users2 }
// ─────────────────────────────────────────────────────────────────────────────

import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { useSystemState } from "@/hooks/useSystemState";
import { useAlerts } from "@/hooks/useAlerts";
import { useSignals } from "@/hooks/useSignals";
import { useExperiments } from "@/hooks/useExperiments";
import { isStale } from "@/hooks/useRelativeTime";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Brain,
  DollarSign,
  LayoutDashboard,
  Shield,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  Users2,
  Wifi,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";

// ─── types ────────────────────────────────────────────────────────────────────

type AgentTone = "cyan" | "amber" | "green" | "red" | "violet" | "neutral";
type DotState  = "active" | "idle" | "alert" | "blocked";

interface AgentDef {
  id: string;
  name: string;
  role: string;
  dept: string;
  deptTone: AgentTone;
  icon: ReactNode;
  primaryLink: string;
  can: string[];
  cannot: string[];
  /** Computed at runtime from live state */
  dot: DotState;
  statusLine: string;
  lastAction?: string;
}

// ─── dot ─────────────────────────────────────────────────────────────────────

function AgentDot({ state }: { state: DotState }) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 rounded-full shrink-0",
        state === "active"  && "bg-primary animate-pulse-soft shadow-[0_0_4px_hsl(var(--primary)/0.6)]",
        state === "idle"    && "bg-muted-foreground/30",
        state === "alert"   && "bg-status-caution animate-pulse-soft",
        state === "blocked" && "bg-status-blocked animate-pulse-soft",
      )}
    />
  );
}

// ─── tone palette ─────────────────────────────────────────────────────────────

const TONE: Record<AgentTone, { dept: string; bg: string; border: string; can: string }> = {
  cyan:    { dept: "text-primary",         bg: "bg-primary/5",          border: "border-primary/25",         can: "bg-primary/10 text-primary border-primary/20"         },
  amber:   { dept: "text-status-caution",  bg: "bg-status-caution/5",   border: "border-status-caution/20",  can: "bg-status-caution/10 text-status-caution border-status-caution/20" },
  green:   { dept: "text-status-safe",     bg: "bg-status-safe/5",      border: "border-status-safe/20",     can: "bg-status-safe/10 text-status-safe border-status-safe/20"     },
  red:     { dept: "text-status-blocked",  bg: "bg-status-blocked/5",   border: "border-status-blocked/20",  can: "bg-status-blocked/10 text-status-blocked border-status-blocked/20" },
  violet:  { dept: "text-[hsl(280_60%_65%)]", bg: "bg-[hsl(280_60%_65%/0.05)]", border: "border-[hsl(280_60%_65%/0.2)]", can: "bg-[hsl(280_60%_65%/0.1)] text-[hsl(280_60%_65%)] border-[hsl(280_60%_65%/0.2)]" },
  neutral: { dept: "text-muted-foreground", bg: "bg-secondary/40",      border: "border-border",             can: "bg-secondary text-muted-foreground border-border"       },
};

// ─── card ─────────────────────────────────────────────────────────────────────

function AgentCard({ agent }: { agent: AgentDef }) {
  const t = TONE[agent.deptTone];

  return (
    <div
      className={cn(
        "panel flex flex-col gap-4 p-5 transition-all hover:border-border/80",
        t.bg,
        t.border,
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3">
          {/* Icon circle */}
          <div
            className={cn(
              "h-10 w-10 rounded-lg border flex items-center justify-center shrink-0",
              t.border,
            )}
          >
            <span className={t.dept}>{agent.icon}</span>
          </div>
          <div>
            <div className={cn("text-[10px] font-semibold uppercase tracking-wider mb-0.5", t.dept)}>
              ⬡ {agent.dept}
            </div>
            <div className="text-base font-bold text-foreground leading-tight">{agent.name}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{agent.role}</div>
          </div>
        </div>
        <Link
          to={agent.primaryLink}
          className="shrink-0 text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
        >
          Open <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {/* Status */}
      <div className="flex items-center gap-2">
        <AgentDot state={agent.dot} />
        <span className="text-xs text-foreground/80">{agent.statusLine}</span>
      </div>

      {/* Last action */}
      {agent.lastAction && (
        <div className="text-[11px] text-muted-foreground border-t border-border/50 pt-2">
          <span className="text-muted-foreground/50 uppercase tracking-wider text-[9px]">Last: </span>
          {agent.lastAction}
        </div>
      )}

      {/* Authority */}
      <div className="space-y-2">
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground/50">
          Authority
        </div>
        <div className="flex flex-wrap gap-1.5">
          {agent.can.map((c) => (
            <span
              key={c}
              className={cn(
                "inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-sm border font-medium",
                t.can,
              )}
            >
              ✓ {c}
            </span>
          ))}
          {agent.cannot.map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-sm border bg-status-blocked/5 text-status-blocked/70 border-status-blocked/15 font-medium"
            >
              ✗ {c}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function Company() {
  const { data: system } = useSystemState();
  const { alerts } = useAlerts();
  const { pending: pendingSignals } = useSignals();
  const { counts: expCounts } = useExperiments();

  const snapshot       = system?.lastEngineSnapshot ?? null;
  const gateReasons    = snapshot?.gateReasons ?? [];
  const dataStale      = isStale(snapshot ? new Date(snapshot.ranAt).getTime() : null);
  const criticalAlerts = alerts.filter((a) => a.severity === "critical");
  const hardBlocks     = gateReasons.filter((r) => r.severity === "halt" || r.severity === "block");
  const decision       = system?.lastJessicaDecision;

  const agents: AgentDef[] = [
    {
      id: "bobby",
      name: "Bobby",
      role: "Executive Operator — you are Bobby. Final authority on every live decision.",
      dept: "Command Center",
      deptTone: "cyan",
      icon: <LayoutDashboard className="h-5 w-5" />,
      primaryLink: "/",
      can: ["Approve trades", "Engage kill switch", "Arm live mode", "Override any gate"],
      cannot: [],
      dot: system?.bot === "running" ? "active" : system?.bot === "halted" ? "blocked" : "idle",
      statusLine: system?.bot === "running"
        ? "Desk is running"
        : system?.bot === "halted"
          ? "Halted — kill switch engaged"
          : system?.bot === "paused" ? "Bot paused" : "Loading…",
      lastAction: decision
        ? `Tick ran ${new Date(decision.ran_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${decision.actions} action${decision.actions === 1 ? "" : "s"}`
        : undefined,
    },
    {
      id: "wags",
      name: "Wags",
      role: "Chief Operating Copilot — synthesizes all agent outputs into proposals for Bobby.",
      dept: "Copilot",
      deptTone: "amber",
      icon: <Sparkles className="h-5 w-5" />,
      primaryLink: "/copilot",
      can: ["Stage trade proposals", "Run signal engine", "Synthesize intel", "Brief Bobby"],
      cannot: ["Execute live orders", "Modify doctrine"],
      dot: pendingSignals.length > 0 ? "active" : "idle",
      statusLine: pendingSignals.length > 0
        ? `${pendingSignals.length} proposal${pendingSignals.length > 1 ? "s" : ""} staged — awaiting Bobby`
        : "Idle — no pending proposals",
      lastAction: pendingSignals[0]
        ? `Proposed ${pendingSignals[0].side.toUpperCase()} ${pendingSignals[0].symbol} @ $${pendingSignals[0].proposedEntry.toFixed(0)}`
        : undefined,
    },
    {
      id: "taylor",
      name: "Taylor",
      role: "Signal Generation Analyst — reads candles, computes regime, proposes entry/exit levels.",
      dept: "Trading Desk",
      deptTone: "green",
      icon: <Zap className="h-5 w-5" />,
      primaryLink: "/copilot",
      can: ["Generate trade signals", "Compute market regime", "Score setups", "Propose entry/stop/target"],
      cannot: ["Approve trades", "Bypass risk gates"],
      dot: pendingSignals.length > 0 ? "active" : snapshot ? "idle" : "idle",
      statusLine: pendingSignals[0]
        ? `${pendingSignals[0].side.toUpperCase()} ${pendingSignals[0].symbol} · ${(pendingSignals[0].confidence * 100).toFixed(0)}% confidence`
        : "No pending signal",
      lastAction: snapshot
        ? `Last scan: ${new Date(snapshot.ranAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : undefined,
    },
    {
      id: "braintrust",
      name: "Brain Trust",
      role: "Market Intelligence Board — macro context, key levels, sentiment, regime classification.",
      dept: "Intelligence",
      deptTone: "violet",
      icon: <Brain className="h-5 w-5" />,
      primaryLink: "/market",
      can: ["Classify market regime", "Surface key levels", "Assess macro context", "Score BTC setup"],
      cannot: ["Propose trades", "Override risk gates"],
      dot: !snapshot ? "idle" : dataStale ? "alert" : "active",
      statusLine: !snapshot
        ? "No snapshot"
        : dataStale
          ? "Context stale — needs refresh"
          : `${(snapshot.perSymbol[0]?.regime ?? "unknown").replace(/_/g, " ")} · ${(snapshot.perSymbol[0]?.confidence * 100 ?? 0).toFixed(0)}% conf`,
      lastAction: snapshot
        ? `Snapshot: ${new Date(snapshot.ranAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : undefined,
    },
    {
      id: "wendy",
      name: "Wendy",
      role: "Post-Trade Learning — reviews closed trades, extracts lessons, updates strategy experiments.",
      dept: "Strategy Lab",
      deptTone: "neutral",
      icon: <BookOpen className="h-5 w-5" />,
      primaryLink: "/learning",
      can: ["Log post-trade lessons", "Update experiments", "Surface patterns"],
      cannot: ["Modify doctrine", "Approve live trades"],
      dot: expCounts.needsReview > 0 ? "alert" : "idle",
      statusLine: expCounts.needsReview > 0
        ? `${expCounts.needsReview} experiment${expCounts.needsReview > 1 ? "s" : ""} need review`
        : "No experiments pending",
    },
    {
      id: "katrina",
      name: "Katrina",
      role: "Review & Governance — audits strategy performance, promotes/retires strategies.",
      dept: "Strategy Lab",
      deptTone: "neutral",
      icon: <TrendingUp className="h-5 w-5" />,
      primaryLink: "/strategy",
      can: ["Audit strategy performance", "Promote / retire strategies", "Flag underperformers"],
      cannot: ["Execute trades", "Modify live doctrine"],
      dot: expCounts.needsReview > 0 ? "alert" : "idle",
      statusLine: expCounts.needsReview > 0
        ? "Strategies flagged for review"
        : "All strategies current",
    },
    {
      id: "hall",
      name: "Hall",
      role: "Infrastructure Commander — monitors feeds, broker connection, resolves incidents.",
      dept: "Infrastructure",
      deptTone: "green",
      icon: <Wifi className="h-5 w-5" />,
      primaryLink: "/alerts",
      can: ["Monitor system health", "Triage incidents", "Reconnect feeds", "Diagnose broker issues"],
      cannot: ["Make trading decisions", "Override risk gates"],
      dot: criticalAlerts.length > 0 ? "blocked" : system?.dataFeed === "connected" ? "active" : "alert",
      statusLine: criticalAlerts.length > 0
        ? `${criticalAlerts.length} critical incident${criticalAlerts.length > 1 ? "s" : ""} active`
        : system?.dataFeed === "connected"
          ? "All systems nominal"
          : "Data feed degraded",
      lastAction: criticalAlerts[0]
        ? criticalAlerts[0].title
        : undefined,
    },
    {
      id: "risk",
      name: "Risk / Compliance",
      role: "Doctrine enforcer — runs gates before every trade, triggers halts at breaches.",
      dept: "Risk Center",
      deptTone: "red",
      icon: <ShieldAlert className="h-5 w-5" />,
      primaryLink: "/risk",
      can: ["Enforce all guardrails", "Trigger auto-halts", "Block over-limit trades", "Compute loss cap"],
      cannot: ["Be overridden without Bobby", "Allow floor breaches"],
      dot: hardBlocks.length > 0 ? "blocked" : "active",
      statusLine: hardBlocks.length > 0
        ? `${hardBlocks.length} gate${hardBlocks.length > 1 ? "s" : ""} blocking new trades`
        : "All guardrails clear",
      lastAction: hardBlocks[0]
        ? `Blocked: ${hardBlocks[0].message.slice(0, 50)}`
        : undefined,
    },
    {
      id: "broker",
      name: "Broker Gateway",
      role: "Money rails — submits and manages live orders via Coinbase API.",
      dept: "Trading Desk",
      deptTone: "green",
      icon: <DollarSign className="h-5 w-5" />,
      primaryLink: "/settings",
      can: ["Submit live orders", "Cancel open orders", "Report fill status"],
      cannot: ["Decide trade direction", "Override stop-loss"],
      dot: system?.brokerConnection === "connected"
        ? "active"
        : system?.brokerConnection === "degraded"
          ? "alert"
          : "blocked",
      statusLine: system?.brokerConnection === "connected"
        ? "Connected · orders enabled"
        : system?.brokerConnection === "degraded"
          ? "Degraded — check settings"
          : "Disconnected — no live orders",
    },
    {
      id: "mtm",
      name: "Mark-to-Market",
      role: "Valuations — prices open positions continuously, updates equity and PnL in real time.",
      dept: "Trading Desk",
      deptTone: "green",
      icon: <Activity className="h-5 w-5" />,
      primaryLink: "/trades",
      can: ["Price open positions", "Update equity", "Compute unrealized PnL", "Roll daily metrics"],
      cannot: ["Execute orders", "Modify position size"],
      dot: "active",
      statusLine: "Running continuously",
    },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="The Desk"
        title="Company"
        description="Meet the AI agents that run your trading company. Each agent owns a department, has defined authority, and reports its current status."
      />

      {/* Department legend */}
      <div className="flex flex-wrap gap-2">
        {[
          { label: "Command Center", tone: "cyan" as AgentTone },
          { label: "Copilot",        tone: "amber" as AgentTone },
          { label: "Trading Desk",   tone: "green" as AgentTone },
          { label: "Intelligence",   tone: "violet" as AgentTone },
          { label: "Strategy Lab",   tone: "neutral" as AgentTone },
          { label: "Risk Center",    tone: "red" as AgentTone },
        ].map(({ label, tone }) => (
          <span
            key={label}
            className={cn(
              "inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider",
              "px-2.5 py-1 rounded-full border",
              TONE[tone].can,
            )}
          >
            ⬡ {label}
          </span>
        ))}
      </div>

      {/* Agent grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>

      {/* Status summary strip */}
      <div className="panel p-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-soft" />
          <span>Active</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
          <span>Idle</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-status-caution animate-pulse-soft" />
          <span>Needs attention</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-status-blocked animate-pulse-soft" />
          <span>Blocked / incident</span>
        </div>
        <div className="flex-1" />
        <Link to="/copilot" className="text-primary hover:underline inline-flex items-center gap-1">
          <Users2 className="h-3.5 w-3.5" />
          Ask any agent a question in Copilot →
        </Link>
      </div>
    </div>
  );
}
