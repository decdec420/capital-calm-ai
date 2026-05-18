// ============================================================
// Decision Memory — _shared edition (Deno-compatible)
// ------------------------------------------------------------
// Records non-trade decisions (vetoed, skipped, blocked) to
// the decision_memory table so Wendy, Strategy Lab, and future
// research jobs can learn from what was avoided.
//
// Safety invariants enforced by this module:
//   - NEVER includes broker credentials, API keys, auth headers.
//   - NEVER triggers broker execution.
//   - NEVER weakens or bypasses risk gates.
//   - NEVER includes full prompt text (use version tags only).
//   - All writes are best-effort / fire-and-forget; failures are
//     logged but never propagate to the caller.
//
// Mirrors src/lib/decision-memory.ts — kept in sync manually.
// ============================================================

/** Canonical reason codes for non-trade decisions. */
export type NonTradeReasonCode =
  // Market / regime skips
  | "NO_TRADE_REGIME"          // Chop / range without RSI extreme
  | "LOW_SETUP_SCORE"          // setup_score below minimum threshold
  | "LOW_CONFIDENCE"           // AI confidence below threshold
  | "COACH_PENALTY"            // Coach multiplier pushed conf below MIN_CONFIDENCE (silent skip gap)
  | "EDGE_BELOW_COSTS"         // Expected edge to TP1 < round-trip fees + slippage
  | "AI_ERROR"                 // AI gateway unavailable or parse failure
  // Risk gate blocks
  | "RISK_GATE_BLOCK"          // Generic halt/block from the risk gate stack
  | "KILL_SWITCH_ACTIVE"       // Kill switch engaged
  | "DAILY_LOSS_CAP_REACHED"   // Daily realized loss cap reached
  | "ACCOUNT_FLOOR_BREACHED"   // Balance below kill-switch floor
  | "MAX_TRADES_REACHED"       // Daily trade count cap reached
  | "COOLDOWN_ACTIVE"          // Reentry cooldown or anti-tilt pause
  | "DOCTRINE_BLOCK"           // Doctrine overlay lockout, correlation cap, or book exposure cap
  | "DEFAULT_LONG_FALLBACK_BLOCKED" // Missing/unknown side refused; never default long
  // Brain Trust / data quality
  | "BRAIN_TRUST_STALE"        // Momentum stale or Brain Trust refresh failed
  | "MARKET_DATA_STALE"        // Candle feed unavailable or stale
  // Strategy routing
  | "NO_APPROVED_STRATEGY"     // No approved strategy for this regime + side combination
  // AI veto paths
  | "RISK_MANAGER_VETO"        // Risk Manager (Bobby/Wags) explicitly vetoed the trade
  | "RISK_MANAGER_SKIP_TICK"   // Risk Manager unavailable — transient infra failure (was invisible)
  // Portfolio risk blocks
  | "PORTFOLIO_RISK_BLOCK"     // Portfolio-level risk gate blocked the decision (exposure/positions/unknown)
  // Operator action
  | "OPERATOR_REJECTED";       // Operator rejected a pending proposal (also in trade_signals)

/**
 * Non-sensitive replay snapshot stored in decision_memory.replay_packet.
 * Follows the same security rules as DecisionReplayPacket:
 *   - No credentials, API keys, or auth headers.
 *   - No raw prompt text (version tag only).
 *   - No raw candle arrays (summaries only).
 */
export interface NonTradeReplayPacket {
  /** Canonical trade-decision score/reasons captured at decision time. */
  tradeDecision?: Record<string, unknown>;
  /** ISO timestamp when this decision was made. */
  ranAt: string;
  /** Symbol being evaluated (null for account-level halts). */
  symbol: string | null;
  /** Market regime at decision time. */
  regime: string | null;
  /** Setup score at decision time. */
  setupScore: number | null;
  /** Confidence at decision time (post-coach-penalty if applicable). */
  confidence: number | null;
  /** Trading mode: paper | live. */
  mode: string;
  /** All gate codes that fired during this evaluation. */
  blockerCodes: string[];
  /** Human-readable summary of why this was not a trade. */
  reason: string;
  /**
   * Provenance of the AI call that produced or influenced this decision.
   * Absent for purely gate-only paths where no AI was called.
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
  /**
   * Optional structured context specific to the reason type.
   * Must never contain credentials or PII.
   */
  meta?: Record<string, unknown>;
}

/** Parameters for recording a non-trade decision. */
export interface RecordNonTradeParams {
  userId: string;
  symbol?: string | null;
  strategyId?: string | null;
  reasonCode: NonTradeReasonCode;
  severity: "halt" | "block" | "skip" | "warn";
  mode: "paper" | "live" | "research";
  marketRegime?: string | null;
  confidence?: number | null;
  setupScore?: number | null;
  blockerCodes?: string[];
  replayPacket?: NonTradeReplayPacket | null;
  /** Override source_agent. Defaults to "signal_engine". */
  sourceAgent?: string;
}

/**
 * Persist a non-trade decision to the decision_memory table.
 *
 * Always fire-and-forget — never throws, never blocks the calling tick.
 * Call with a service-role admin client (service role bypasses RLS).
 *
 * Security: the caller is responsible for ensuring replayPacket contains
 * no credentials, API keys, or sensitive user data before passing it.
 */
// deno-lint-ignore no-explicit-any
export async function recordNonTrade(
  admin: any,
  params: RecordNonTradeParams,
): Promise<void> {
  try {
    const { error } = await admin.from("decision_memory").insert({
      user_id: params.userId,
      symbol: params.symbol ?? null,
      strategy_id: params.strategyId ?? null,
      event_type: "non_trade",
      source_agent: params.sourceAgent ?? "signal_engine",
      reason_code: params.reasonCode,
      severity: params.severity,
      mode: params.mode,
      market_regime: params.marketRegime ?? null,
      confidence: params.confidence ?? null,
      setup_score: params.setupScore ?? null,
      replay_packet: params.replayPacket ?? null,
      blocker_codes: params.blockerCodes ?? [],
      used_for_learning: false,
    });
    if (error) {
      console.warn("[decision-memory] insert error:", error.message);
    }
  } catch (err) {
    // Best-effort — never propagate to caller
    console.warn(
      "[decision-memory] recordNonTrade failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Build a minimal NonTradeReplayPacket from available context.
 * Safe to call for any non-trade path.
 *
 * Pass provenance when an AI call was involved in producing this decision.
 * Omit for purely gate-based / deterministic paths (no AI call).
 */
export function buildNonTradePacket(params: {
  symbol: string | null;
  regime: string | null;
  setupScore: number | null;
  confidence: number | null;
  mode: "paper" | "live" | "research";
  blockerCodes: string[];
  reason: string;
  provenance?: NonTradeReplayPacket["provenance"];
  tradeDecision?: NonTradeReplayPacket["tradeDecision"];
  meta?: Record<string, unknown>;
}): NonTradeReplayPacket {
  return {
    ranAt: new Date().toISOString(),
    symbol: params.symbol,
    regime: params.regime,
    setupScore: params.setupScore,
    confidence: params.confidence,
    mode: params.mode,
    blockerCodes: params.blockerCodes,
    reason: params.reason,
    ...(params.tradeDecision ? { tradeDecision: params.tradeDecision } : {}),
    ...(params.provenance ? { provenance: params.provenance } : {}),
    ...(params.meta ? { meta: params.meta } : {}),
  };
}
