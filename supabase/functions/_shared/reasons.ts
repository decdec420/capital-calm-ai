// ============================================================
// Structured reason codes (gates, risk, lifecycle)
// ------------------------------------------------------------
// Authoritative. Browser reads from this; never forks.
// Ported from decdec420/Trader → src/execution/reasons.ts.
// Unified with the Lovable GateReason shape so UIs can switch
// on `code` for icon/tone and render `message` as the line.
// ============================================================

export type GateSeverity = "halt" | "block" | "skip" | "info" | "warn";

// All reason codes we emit. Keep this list exhaustive so the UI can render
// every one with a known icon, tone, and copy. Novel codes must be added here
// before they can land in a response.
export const GATE_CODES = {
  // Doctrine / sizing
  DOCTRINE_MAX_ORDER: "DOCTRINE_MAX_ORDER",
  DOCTRINE_SYMBOL_NOT_ALLOWED: "DOCTRINE_SYMBOL_NOT_ALLOWED",
  DOCTRINE_KILL_SWITCH_FLOOR: "DOCTRINE_KILL_SWITCH_FLOOR",
  DOCTRINE_INVALID_SIZE: "DOCTRINE_INVALID_SIZE",
  DOCTRINE_QTY_TOO_SMALL: "DOCTRINE_QTY_TOO_SMALL",

  // Account-level halts
  KILL_SWITCH: "KILL_SWITCH",
  BOT_HALTED: "BOT_HALTED",
  BOT_PAUSED: "BOT_PAUSED",
  GUARDRAIL_BLOCKED: "GUARDRAIL_BLOCKED",

  // Position / portfolio conflicts
  OPEN_POSITION: "OPEN_POSITION",
  PENDING_SIGNAL: "PENDING_SIGNAL",

  // Daily caps
  DAILY_LOSS_CAP: "DAILY_LOSS_CAP",
  TRADE_COUNT_CAP: "TRADE_COUNT_CAP",
  BALANCE_FLOOR: "BALANCE_FLOOR",
  COOLDOWN: "COOLDOWN",

  // Market state
  NO_CANDLES: "NO_CANDLES",
  CHOP_REGIME: "CHOP_REGIME",
  RANGE_REGIME: "RANGE_REGIME",
  LOW_SETUP_SCORE: "LOW_SETUP_SCORE",
  EXTREME_VOLATILITY: "EXTREME_VOLATILITY",
  OUTSIDE_LIQUIDITY_WINDOW: "OUTSIDE_LIQUIDITY_WINDOW",
  STALE_DATA: "STALE_DATA",
  SPREAD_TOO_WIDE: "SPREAD_TOO_WIDE",

  // AI / engine
  AI_SKIP: "AI_SKIP",
  AI_ERROR: "AI_ERROR",
  INSERT_ERROR: "INSERT_ERROR",
  NO_QUALIFYING_SETUP: "NO_QUALIFYING_SETUP",
  NO_SYSTEM_STATE: "NO_SYSTEM_STATE",
} as const;

export type GateCode = (typeof GATE_CODES)[keyof typeof GATE_CODES];

export interface GateReason {
  code: GateCode;
  severity: GateSeverity;
  message: string;
  meta?: Record<string, unknown>;
}

export function gate(
  code: GateCode,
  severity: GateSeverity,
  message: string,
  meta?: Record<string, unknown>,
): GateReason {
  return meta ? { code, severity, message, meta } : { code, severity, message };
}

// Lifecycle reason codes (why a trade transitioned phase)
export const LIFECYCLE_REASONS = {
  PROPOSED: "proposed",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXPIRED: "ttl_elapsed",
  ENTERED: "entered",
  MONITORED: "monitored",
  TP1_HIT: "tp1_hit",
  STOP_LOSS_HIT: "stop_loss_hit",
  TAKE_PROFIT_HIT: "take_profit_hit",
  MANUAL_EXIT: "manual_exit",
  END_OF_DAY_EXIT: "end_of_day_exit",
  ARCHIVED: "archived",
} as const;

export type LifecycleReason =
  (typeof LIFECYCLE_REASONS)[keyof typeof LIFECYCLE_REASONS];
