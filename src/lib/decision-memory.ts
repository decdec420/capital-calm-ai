// ============================================================
// Decision Memory — browser-side types
// ------------------------------------------------------------
// Type-only mirror of supabase/functions/_shared/decision-memory.ts.
// Used by frontend components (Wendy, Strategy Lab, Risk Center)
// to read and display decision_memory records.
//
// Safety rules:
//   - These types describe READ paths only.
//   - No execution logic lives here.
//   - Mirrors the DB schema in decision_memory table.
//   - Must be kept in sync with the _shared edition.
// ============================================================

/** Canonical reason codes for non-trade decisions. */
export type NonTradeReasonCode =
  // Market / regime skips
  | "NO_TRADE_REGIME"
  | "LOW_SETUP_SCORE"
  | "LOW_CONFIDENCE"
  | "COACH_PENALTY"
  | "EDGE_BELOW_COSTS"
  | "AI_ERROR"
  // Risk gate blocks
  | "RISK_GATE_BLOCK"
  | "KILL_SWITCH_ACTIVE"
  | "DAILY_LOSS_CAP_REACHED"
  | "ACCOUNT_FLOOR_BREACHED"
  | "MAX_TRADES_REACHED"
  | "COOLDOWN_ACTIVE"
  | "DOCTRINE_BLOCK"
  // Brain Trust / data quality
  | "BRAIN_TRUST_STALE"
  | "MARKET_DATA_STALE"
  // Strategy routing
  | "NO_APPROVED_STRATEGY"
  // AI veto paths
  | "AI_DISCRETIONARY_SKIP"
  | "RISK_MANAGER_VETO"
  | "RISK_MANAGER_SKIP_TICK"
  // Operator action
  | "OPERATOR_REJECTED";

/** Severity levels matching GateSeverity. */
export type DecisionMemorySeverity = "halt" | "block" | "skip" | "warn";

/** Trading mode at decision time. */
export type DecisionMemoryMode = "paper" | "live" | "research";

/**
 * Non-sensitive replay snapshot stored in decision_memory.replay_packet.
 * Same security rules as DecisionReplayPacket in decision-replay.ts.
 */
export interface NonTradeReplayPacket {
  ranAt: string;
  symbol: string | null;
  regime: string | null;
  setupScore: number | null;
  confidence: number | null;
  mode: string;
  blockerCodes: string[];
  reason: string;
  /**
   * Provenance of the AI call that produced or influenced this decision.
   * Absent for purely deterministic / gate-only paths where no AI was called.
   * Never contains credentials, API keys, or full prompt text.
   */
  provenance?: {
    model: string;
    promptId: string;
    promptVersion: string;
    schemaVersion: string;
    validationStatus: "passed" | "failed" | "fallback" | "skipped";
    fallbackUsed: boolean;
    fallbackReason?: string;
  };
  meta?: Record<string, unknown>;
}

/** A single row from the decision_memory table. */
export interface DecisionMemoryRow {
  id: string;
  user_id: string;
  symbol: string | null;
  strategy_id: string | null;
  event_type: string;
  source_agent: string;
  reason_code: NonTradeReasonCode;
  severity: DecisionMemorySeverity;
  mode: DecisionMemoryMode;
  market_regime: string | null;
  confidence: number | null;
  setup_score: number | null;
  replay_packet: NonTradeReplayPacket | null;
  blocker_codes: string[];
  used_for_learning: boolean;
  created_at: string;
}

/**
 * Human-readable labels for reason codes.
 * Used by UI components (Strategy Lab, Risk Center, Wendy).
 */
export const REASON_CODE_LABELS: Record<NonTradeReasonCode, string> = {
  NO_TRADE_REGIME: "No-trade regime",
  LOW_SETUP_SCORE: "Low setup score",
  LOW_CONFIDENCE: "Low AI confidence",
  COACH_PENALTY: "Coach penalty (confidence reduced below threshold)",
  EDGE_BELOW_COSTS: "Edge below round-trip costs",
  AI_ERROR: "AI gateway error",
  RISK_GATE_BLOCK: "Risk gate block",
  KILL_SWITCH_ACTIVE: "Kill switch active",
  DAILY_LOSS_CAP_REACHED: "Daily loss cap reached",
  ACCOUNT_FLOOR_BREACHED: "Account floor breached",
  MAX_TRADES_REACHED: "Daily trade cap reached",
  COOLDOWN_ACTIVE: "Cooldown active",
  DOCTRINE_BLOCK: "Doctrine block",
  BRAIN_TRUST_STALE: "Brain Trust stale / degraded",
  MARKET_DATA_STALE: "Market data stale",
  NO_APPROVED_STRATEGY: "No approved strategy for regime",
  AI_DISCRETIONARY_SKIP: "AI discretionary skip (scores above threshold)",
  RISK_MANAGER_VETO: "Risk Manager veto",
  RISK_MANAGER_SKIP_TICK: "Risk Manager unavailable (transient)",
  OPERATOR_REJECTED: "Operator rejected",
};

/**
 * Whether a reason code represents a safety-correct block
 * (as opposed to a potentially-improvable skip).
 * Used by Strategy Lab to triage learning opportunities.
 */
export function isSafetyBlock(code: NonTradeReasonCode): boolean {
  return [
    "KILL_SWITCH_ACTIVE",
    "DAILY_LOSS_CAP_REACHED",
    "ACCOUNT_FLOOR_BREACHED",
    "MAX_TRADES_REACHED",
    "COOLDOWN_ACTIVE",
    "DOCTRINE_BLOCK",
    "RISK_GATE_BLOCK",
  ].includes(code);
}

/**
 * Whether a reason code is a learning opportunity
 * (the signal had potential but was filtered).
 */
export function isLearningOpportunity(code: NonTradeReasonCode): boolean {
  return [
    "NO_TRADE_REGIME",
    "LOW_SETUP_SCORE",
    "LOW_CONFIDENCE",
    "COACH_PENALTY",
    "EDGE_BELOW_COSTS",
    "BRAIN_TRUST_STALE",
    "NO_APPROVED_STRATEGY",
    "AI_DISCRETIONARY_SKIP",
    "RISK_MANAGER_VETO",
  ].includes(code);
}
