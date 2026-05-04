// ─────────────────────────────────────────────────────────────────────────────
// P1: AgentStatusRow.tsx
// New file → src/components/trader/AgentStatusRow.tsx
//
// A horizontal row of 8 agent status mini-cards for the Overview page.
// Each card shows: status dot + agent name + role + current action.
// Clicking a card navigates to that agent's primary page.
//
// Wire into Overview.tsx — add after the <SymbolStrip> block:
//   import { AgentStatusRow } from "@/components/trader/AgentStatusRow";
//   // After <SymbolStrip .../>:
//   <AgentStatusRow />
// ─────────────────────────────────────────────────────────────────────────────

import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useSystemState } from "@/hooks/useSystemState";
import { useAlerts } from "@/hooks/useAlerts";
import { useSignals } from "@/hooks/useSignals";
import { useExperiments } from "@/hooks/useExperiments";
import { isStale } from "@/hooks/useRelativeTime";

// ─── types ────────────────────────────────────────────────────────────────────

type AgentStatus = "active" | "idle" | "alert" | "blocked" | "unknown";

interface AgentCardData {
  id: string;
  name: string;
  role: string;
  dept: string;
  status: AgentStatus;
  statusLabel: string;
  to: string;
}

// ─── dot ─────────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: AgentStatus }) {
  return (
    <span
      className={cn(
        "inline-block h-1.5 w-1.5 rounded-full shrink-0",
        status === "active"  && "bg-primary animate-pulse-soft",
        status === "idle"    && "bg-muted-foreground/40",
        status === "alert"   && "bg-status-caution animate-pulse-soft",
        status === "blocked" && "bg-status-blocked animate-pulse-soft",
        status === "unknown" && "bg-muted-foreground/25",
      )}
    />
  );
}

// ─── card ─────────────────────────────────────────────────────────────────────

function AgentCard({ agent }: { agent: AgentCardData }) {
  return (
    <Link
      to={agent.to}
      className={cn(
        "flex-1 min-w-0 rounded-md border bg-card/50 px-3 py-2",
        "flex flex-col gap-0.5 transition-colors group",
        "hover:border-primary/40 hover:bg-card/80",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        agent.status === "active"  && "border-primary/25",
        agent.status === "alert"   && "border-status-caution/30",
        agent.status === "blocked" && "border-status-blocked/30",
        agent.status === "idle"    && "border-border",
        agent.status === "unknown" && "border-border",
      )}
      aria-label={`${agent.name} — ${agent.statusLabel}`}
    >
      {/* Name + dot */}
      <div className="flex items-center gap-1.5">
        <StatusDot status={agent.status} />
        <span className="text-[11px] font-semibold text-foreground leading-none truncate">
          {agent.name}
        </span>
      </div>

      {/* Role */}
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground/60 leading-none">
        {agent.role}
      </span>

      {/* Current action */}
      <span
        className={cn(
          "text-[10px] leading-snug truncate mt-0.5",
          agent.status === "active"  && "text-primary",
          agent.status === "alert"   && "text-status-caution",
          agent.status === "blocked" && "text-status-blocked",
          agent.status === "idle"    && "text-muted-foreground",
          agent.status === "unknown" && "text-muted-foreground/50",
        )}
      >
        {agent.statusLabel}
      </span>
    </Link>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export function AgentStatusRow() {
  const { data: system } = useSystemState();
  const { alerts } = useAlerts();
  const { pending: pendingSignals } = useSignals();
  const { counts: expCounts } = useExperiments();

  const snapshot = system?.lastEngineSnapshot ?? null;
  const decision = system?.lastJessicaDecision ?? null;

  // ── Bobby ──────────────────────────────────────────────────────────────────
  const bobbyStatus: AgentStatus =
    system?.bot === "running" ? "active" :
    system?.bot === "halted"  ? "blocked" :
    system?.bot === "paused"  ? "idle" : "unknown";
  const bobbyLabel =
    system?.bot === "running" ? "Desk is running" :
    system?.bot === "halted"  ? "Halted — kill switch" :
    system?.bot === "paused"  ? "Paused" : "Loading…";

  // ── Wags (copilot) ─────────────────────────────────────────────────────────
  const wagsStatus: AgentStatus = pendingSignals.length > 0 ? "active" : "idle";
  const wagsLabel = pendingSignals.length > 0
    ? `${pendingSignals.length} proposal${pendingSignals.length > 1 ? "s" : ""} ready`
    : decision
      ? `Last tick: ${decision.actions} action${decision.actions === 1 ? "" : "s"}`
      : "Idle";

  // ── Taylor (signals) ───────────────────────────────────────────────────────
  const lastSig = pendingSignals[0] ?? null;
  const taylorStatus: AgentStatus = lastSig ? "active" : "idle";
  const taylorLabel = lastSig
    ? `${lastSig.side.toUpperCase()} ${lastSig.symbol} · ${(lastSig.confidence * 100).toFixed(0)}% conf`
    : "No pending signals";

  // ── Brain Trust (market intelligence) ──────────────────────────────────────
  const snapshotStale = isStale(snapshot ? new Date(snapshot.ranAt).getTime() : null);
  const brainStatus: AgentStatus = !snapshot ? "unknown" : snapshotStale ? "alert" : "active";
  const brainLabel = !snapshot
    ? "No snapshot yet"
    : snapshotStale
      ? "Context stale — refresh"
      : `${snapshot.perSymbol[0]?.regime?.replace(/_/g, " ") ?? "reading market"}`;

  // ── Wendy (learning) ───────────────────────────────────────────────────────
  const wendyStatus: AgentStatus = expCounts.needsReview > 0 ? "alert" : "idle";
  const wendyLabel = expCounts.needsReview > 0
    ? `${expCounts.needsReview} experiment${expCounts.needsReview > 1 ? "s" : ""} to review`
    : "Idle";

  // ── Katrina (strategy review) ───────────────────────────────────────────────
  const katrinaStatus: AgentStatus = expCounts.needsReview > 0 ? "alert" : "idle";
  const katrinaLabel = expCounts.needsReview > 0
    ? `${expCounts.needsReview} strategy review${expCounts.needsReview > 1 ? "s" : ""} pending`
    : "All strategies reviewed";

  // ── Hall (infrastructure) ──────────────────────────────────────────────────
  const criticalAlerts = alerts.filter((a) => a.severity === "critical");
  const hallStatus: AgentStatus = criticalAlerts.length > 0 ? "blocked" : "active";
  const hallLabel = criticalAlerts.length > 0
    ? `${criticalAlerts.length} critical incident${criticalAlerts.length > 1 ? "s" : ""}`
    : system?.dataFeed === "connected" ? "All systems nominal" : "Feed degraded";

  // ── Risk (compliance/gates) ────────────────────────────────────────────────
  const gateReasons = snapshot?.gateReasons ?? [];
  const hardBlocks = gateReasons.filter((r) => r.severity === "halt" || r.severity === "block");
  const riskStatus: AgentStatus = hardBlocks.length > 0 ? "blocked" : "active";
  const riskLabel = hardBlocks.length > 0
    ? `${hardBlocks.length} gate${hardBlocks.length > 1 ? "s" : ""} blocking trades`
    : "All guardrails clear";

  const agents: AgentCardData[] = [
    { id: "bobby",      name: "Bobby",       role: "Exec Operator",  dept: "Command",    status: bobbyStatus,  statusLabel: bobbyLabel,  to: "/" },
    { id: "wags",       name: "Wags",        role: "Chief Copilot",  dept: "Copilot",    status: wagsStatus,   statusLabel: wagsLabel,   to: "/copilot" },
    { id: "taylor",     name: "Taylor",      role: "Signal Analyst", dept: "Trading",    status: taylorStatus, statusLabel: taylorLabel, to: "/copilot" },
    { id: "braintrust", name: "Brain Trust", role: "Intelligence",   dept: "Intel",      status: brainStatus,  statusLabel: brainLabel,  to: "/market" },
    { id: "wendy",      name: "Wendy",       role: "Learning",       dept: "Strategy",   status: wendyStatus,  statusLabel: wendyLabel,  to: "/learning" },
    { id: "katrina",    name: "Katrina",     role: "Governance",     dept: "Strategy",   status: katrinaStatus,statusLabel: katrinaLabel,to: "/strategy" },
    { id: "hall",       name: "Hall",        role: "Infrastructure", dept: "Ops",        status: hallStatus,   statusLabel: hallLabel,   to: "/alerts" },
    { id: "risk",       name: "Risk",        role: "Compliance",     dept: "Risk",       status: riskStatus,   statusLabel: riskLabel,   to: "/risk" },
  ];

  return (
    <div className="flex gap-2 overflow-x-auto pb-0.5 animate-fade-in">
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </div>
  );
}
