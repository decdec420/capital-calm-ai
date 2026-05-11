// ============================================================
// Incident Classification — pure helpers
// ------------------------------------------------------------
// Maps raw event types and conditions to structured incident
// metadata used by the Hall/Ops timeline.
//
// Rules:
//   - Pure functions, no side effects, no DB calls.
//   - Never overstates severity.
//   - Read-only AI guard surface → warning (not critical).
//   - Broker / live-execution issues → critical.
//   - Kill switch active → critical + trading blocked.
//   - Stale data → warning (paper) or critical (live blocking).
// ============================================================

export type IncidentSeverity = "info" | "warning" | "critical";

export type AffectedWorkflow =
  | "market_intelligence"
  | "trade_decision"
  | "strategy_learning"
  | "broker"
  | "ops";

export type OpsReviewStatus =
  | "detected"
  | "diagnosed"
  | "action_taken"
  | "verified"
  | "resolved"
  | "follow_up";

export interface IncidentClassification {
  severity: IncidentSeverity;
  affectedWorkflow: AffectedWorkflow;
  tradingBlocked: boolean;
  moneyAtRisk: boolean;
  userAttentionRequired: boolean;
  rootCause: string;
  label: string;
}

// ─── AI Guard surfaces ────────────────────────────────────────────────────────

const TRADE_SURFACES = new Set([
  "trade_signal",
  "broker_execution",
  "jessica_decision",
  "signal_engine",
  "chuck",
]);

export function classifyAiGuardRejected(surface: string): IncidentClassification {
  const isTradeSurface = TRADE_SURFACES.has(surface);
  return {
    severity: isTradeSurface ? "critical" : "warning",
    affectedWorkflow: isTradeSurface ? "trade_decision" : "ops",
    tradingBlocked: isTradeSurface,
    moneyAtRisk: false,
    userAttentionRequired: isTradeSurface,
    rootCause: `AI output rejected by guard on surface: ${surface}`,
    label: "AI Guard Rejected",
  };
}

export function classifyAiGuardFallback(surface: string): IncidentClassification {
  return {
    severity: "info",
    affectedWorkflow: TRADE_SURFACES.has(surface) ? "trade_decision" : "ops",
    tradingBlocked: false,
    moneyAtRisk: false,
    userAttentionRequired: false,
    rootCause: `AI output used fallback on surface: ${surface}`,
    label: "AI Guard Fallback",
  };
}

// ─── Kill switch ──────────────────────────────────────────────────────────────

export function classifyKillSwitchActive(): IncidentClassification {
  return {
    severity: "critical",
    affectedWorkflow: "trade_decision",
    tradingBlocked: true,
    moneyAtRisk: false,
    userAttentionRequired: true,
    rootCause: "Kill switch is engaged — all trading halted until operator disarms.",
    label: "Kill Switch Engaged",
  };
}

// ─── Risk gate trips ──────────────────────────────────────────────────────────

export function classifyDailyLossCapReached(): IncidentClassification {
  return {
    severity: "warning",
    affectedWorkflow: "trade_decision",
    tradingBlocked: true,
    moneyAtRisk: true,
    userAttentionRequired: true,
    rootCause: "Daily loss cap reached — no new entries until UTC rollover.",
    label: "Daily Loss Cap Reached",
  };
}

export function classifyAccountFloorBreached(): IncidentClassification {
  return {
    severity: "critical",
    affectedWorkflow: "trade_decision",
    tradingBlocked: true,
    moneyAtRisk: true,
    userAttentionRequired: true,
    rootCause: "Account equity is below the kill-switch floor.",
    label: "Account Floor Breached",
  };
}

// ─── Stale data ───────────────────────────────────────────────────────────────

export function classifyBrainTrustStale(mode: "paper" | "live" | "unknown"): IncidentClassification {
  const isLive = mode === "live";
  return {
    severity: isLive ? "critical" : "warning",
    affectedWorkflow: "market_intelligence",
    tradingBlocked: isLive,
    moneyAtRisk: isLive,
    userAttentionRequired: isLive,
    rootCause: "Brain Trust market context is stale — momentum reads are outdated.",
    label: "Brain Trust Stale",
  };
}

export function classifyMarketDataStale(mode: "paper" | "live" | "unknown"): IncidentClassification {
  const isLive = mode === "live";
  return {
    severity: "warning",
    affectedWorkflow: "market_intelligence",
    tradingBlocked: isLive,
    moneyAtRisk: isLive,
    userAttentionRequired: isLive,
    rootCause: "Market data feed is stale or disconnected.",
    label: "Market Data Stale",
  };
}

export function classifyTaylorStale(mode: "paper" | "live" | "unknown"): IncidentClassification {
  const isLive = mode === "live";
  return {
    severity: isLive ? "critical" : "warning",
    affectedWorkflow: "trade_decision",
    tradingBlocked: false,
    moneyAtRisk: false,
    userAttentionRequired: isLive,
    rootCause: "Signal engine (Taylor) has not run within the expected window — cron may be stalled.",
    label: "Taylor Signal Engine Stale",
  };
}

// ─── Cron / heartbeat misses ──────────────────────────────────────────────────

export function classifyCronMiss(agent: string): IncidentClassification {
  return {
    severity: "warning",
    affectedWorkflow: "ops",
    tradingBlocked: false,
    moneyAtRisk: false,
    userAttentionRequired: true,
    rootCause: `Cron missed — ${agent} heartbeat not recorded within expected window.`,
    label: `${agent} Cron Miss`,
  };
}

// ─── Broker / connectivity ────────────────────────────────────────────────────

export function classifyBrokerAuthIssue(): IncidentClassification {
  return {
    severity: "critical",
    affectedWorkflow: "broker",
    tradingBlocked: true,
    moneyAtRisk: true,
    userAttentionRequired: true,
    rootCause: "Coinbase broker authentication failed — live order submission is blocked.",
    label: "Broker Auth Issue",
  };
}

export function classifyBrokerDisconnected(): IncidentClassification {
  return {
    severity: "warning",
    affectedWorkflow: "broker",
    tradingBlocked: false,
    moneyAtRisk: false,
    userAttentionRequired: false,
    rootCause: "Coinbase broker connection is not available (paper mode unaffected).",
    label: "Broker Disconnected",
  };
}

// ─── Bot state ────────────────────────────────────────────────────────────────

export function classifyBotPausedUnexpected(): IncidentClassification {
  return {
    severity: "warning",
    affectedWorkflow: "ops",
    tradingBlocked: true,
    moneyAtRisk: false,
    userAttentionRequired: true,
    rootCause: "Bot paused unexpectedly — signal engine will not run.",
    label: "Bot Paused",
  };
}

// ─── Learning / enrichment jobs ───────────────────────────────────────────────

export function classifyLearningJobFailed(jobName: string): IncidentClassification {
  return {
    severity: "info",
    affectedWorkflow: "strategy_learning",
    tradingBlocked: false,
    moneyAtRisk: false,
    userAttentionRequired: false,
    rootCause: `Background job failed without effect on live trading: ${jobName}`,
    label: "Background Job Failed",
  };
}

// ─── Generic classifier by event_type ────────────────────────────────────────
// Used by the UI hook to classify raw system_event rows.

export interface ClassifyEventInput {
  eventType: string;
  surface?: string;
  mode?: "paper" | "live" | "unknown";
  payload?: Record<string, unknown>;
}

export function classifyEventType(input: ClassifyEventInput): IncidentClassification {
  const { eventType, surface = "unknown", mode = "unknown", payload = {} } = input;

  switch (eventType) {
    case "AI_GUARD_REJECTED":
      return classifyAiGuardRejected(surface);
    case "AI_GUARD_FALLBACK":
      return classifyAiGuardFallback(surface);
    case "kill_switch_on":
      return classifyKillSwitchActive();
    case "kill_switch_off":
      return {
        severity: "info",
        affectedWorkflow: "ops",
        tradingBlocked: false,
        moneyAtRisk: false,
        userAttentionRequired: false,
        rootCause: "Kill switch disarmed — trading may resume.",
        label: "Kill Switch Disarmed",
      };
    case "bot_paused":
      return classifyBotPausedUnexpected();
    case "bot_resumed":
      return {
        severity: "info",
        affectedWorkflow: "ops",
        tradingBlocked: false,
        moneyAtRisk: false,
        userAttentionRequired: false,
        rootCause: "Bot resumed by operator.",
        label: "Bot Resumed",
      };
    case "state_changed": {
      const ks = payload["kill_switch_engaged"];
      if (ks === true || ks === "true") return classifyKillSwitchActive();
      const live = payload["live_trading_enabled"];
      if (live === true || live === "true") {
        return {
          severity: "warning",
          affectedWorkflow: "ops",
          tradingBlocked: false,
          moneyAtRisk: true,
          userAttentionRequired: true,
          rootCause: "Live trading enabled by operator.",
          label: "Live Trading Enabled",
        };
      }
      return {
        severity: "info",
        affectedWorkflow: "ops",
        tradingBlocked: false,
        moneyAtRisk: false,
        userAttentionRequired: false,
        rootCause: "System state changed by operator.",
        label: "State Changed",
      };
    }
    case "autonomy_changed":
      return {
        severity: "info",
        affectedWorkflow: "ops",
        tradingBlocked: false,
        moneyAtRisk: false,
        userAttentionRequired: false,
        rootCause: "Autonomy level changed by operator.",
        label: "Autonomy Changed",
      };
    default:
      return {
        severity: "info",
        affectedWorkflow: "ops",
        tradingBlocked: false,
        moneyAtRisk: false,
        userAttentionRequired: false,
        rootCause: eventType,
        label: eventType,
      };
  }
}

// ─── Severity ordering ────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<IncidentSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function compareSeverity(a: IncidentSeverity, b: IncidentSeverity): number {
  return SEVERITY_ORDER[a] - SEVERITY_ORDER[b];
}

// ─── Label helpers ────────────────────────────────────────────────────────────

export const OPS_STATUS_LABEL: Record<OpsReviewStatus, string> = {
  detected: "Detected",
  diagnosed: "Diagnosed",
  action_taken: "Action Taken",
  verified: "Verified",
  resolved: "Resolved",
  follow_up: "Follow-up",
};

export const WORKFLOW_LABEL: Record<AffectedWorkflow, string> = {
  market_intelligence: "Market Intelligence",
  trade_decision: "Trade Decision",
  strategy_learning: "Strategy Learning",
  broker: "Broker",
  ops: "Ops",
};
