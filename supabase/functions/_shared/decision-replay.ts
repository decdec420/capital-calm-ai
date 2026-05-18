// ============================================================
// Decision Replay Packet — _shared edition (Deno-compatible)
// ------------------------------------------------------------
// Mirrors src/lib/decision-replay.ts — kept in sync manually.
// Used by signal-engine and signal-decide to build and persist
// replay packets at decision time.
//
// Safety invariants enforced by this module:
//   - NEVER include raw broker credentials, API keys, or auth headers.
//   - NEVER include full prompt text (store version tag + input hash only).
//   - NEVER include user PII beyond user_id (which stays in the parent row).
//   - DO store enough metadata to reconstruct risk gate math offline.
// ============================================================

export const REPLAY_PACKET_VERSION = "1" as const;

export interface DoctrineReplaySlice {
  mode: "paper" | "live" | "research" | "learning";
  dailyLossCapUsd: number;
  killSwitchFloorUsd: number;
  maxTradesPerDay: number;
  maxOrderPct: number;
  maxOrderAbsCap: number;
  dailyLossPct: number;
  floorPct: number;
  profile: "sentinel" | "active" | "aggressive";
}

export interface MarketReplaySlice {
  symbol: string;
  regime: string;
  setupScore: number;
  confidence: number;
  volatility: string;
  brainTrustFresh: boolean;
  /** Age of the Brain Trust brief at decision time (minutes). */
  brainTrustAgeMinutes: number | null;
  /** Age of the engine snapshot at decision time (seconds). */
  snapshotAgeSeconds: number;
  /** Hypothetical trade direction. Required for direction-aware outcome enrichment. */
  side?: "long" | "short";
  /** Normalized market regime captured at proposal/entry time. "unknown" means no structured source was available. */
  entryRegime?: string;
  /** Structured source used to populate entryRegime; never AI-inferred. */
  entryRegimeSource?: "signal_regime" | "market_intelligence" | "unknown";
}

export interface ModelReplaySlice {
  /** Taylor AI model identifier — no credentials. */
  taylorModel: string;
  /** Taylor prompt version tag — never the full prompt text. */
  taylorPromptVersion: string;
  /** Risk Manager model identifier. */
  riskManagerModel: string;
  /** Prompt version for the Risk Manager call. */
  riskManagerPromptVersion?: string;
  /** Output schema version used to validate Taylor's response. */
  taylorSchemaVersion?: string;
  /** Output schema version used to validate Risk Manager's response. */
  riskManagerSchemaVersion?: string;
  /** Validation status for Taylor output: passed | failed | fallback | skipped. */
  taylorValidationStatus?: "passed" | "failed" | "fallback" | "skipped";
  /** Validation status for Risk Manager output. */
  riskManagerValidationStatus?: "passed" | "failed" | "fallback" | "skipped";
  /** Whether circuit breaker or AI fallback was used for Taylor. */
  taylorFallbackUsed?: boolean;
  /** Whether circuit breaker or AI fallback was used for Risk Manager. */
  riskManagerFallbackUsed?: boolean;
  /**
   * SHA-256-like hash of the non-sensitive input packet fields.
   * Allows future verification without re-storing the full payload.
   */
  inputPacketHash?: string;
}

export interface GateReplaySlice {
  gates: Array<{
    code: string;
    severity: "halt" | "block" | "skip" | "warn" | "info";
    message: string;
  }>;
  anyRefusal: boolean;
  refusalCodes: string[];
}

export interface DecisionReplayPacket {
  replayVersion: typeof REPLAY_PACKET_VERSION;
  packetCreatedAt: string;
  signalId: string;
  ranAt: string;

  market: MarketReplaySlice;
  doctrine: DoctrineReplaySlice;
  model: ModelReplaySlice;
  gates: GateReplaySlice;
  /** Canonical trade-decision score/reasons captured at decision time. */
  tradeDecision?: Record<string, unknown>;

  decision: "approved" | "vetoed_by_risk_manager" | "skipped_no_signal" | "blocked_by_gate";
  decisionReason: string;

  // Post-trade fields — filled in by post-trade-learn / Wendy:
  actualOutcome?: "win" | "loss" | "breakeven" | "open" | "cancelled";
  wendyGrade?: "A" | "B" | "C" | "D" | "F";
  outcomeRecordedAt?: string;
}

/**
 * Builds a minimal DecisionReplayPacket from the data available at signal-
 * engine INSERT time. Fields that need post-trade data are omitted.
 *
 * Security rules:
 *   - `params` must never contain credentials, API keys, or auth headers.
 *   - `model.taylorPromptVersion` must be a short tag, never full text.
 *   - `doctrine` contains cap numbers only — no raw settings rows.
 */
export function buildDecisionReplayPacket(params: {
  signalId: string;
  ranAt: string;
  market: MarketReplaySlice;
  doctrine: DoctrineReplaySlice;
  model: ModelReplaySlice;
  gates: GateReplaySlice;
  tradeDecision?: DecisionReplayPacket["tradeDecision"];
  decision: DecisionReplayPacket["decision"];
  decisionReason: string;
}): DecisionReplayPacket {
  return {
    replayVersion: REPLAY_PACKET_VERSION,
    packetCreatedAt: new Date().toISOString(),
    signalId: params.signalId,
    ranAt: params.ranAt,
    market: params.market,
    doctrine: params.doctrine,
    model: params.model,
    gates: params.gates,
    ...(params.tradeDecision ? { tradeDecision: params.tradeDecision } : {}),
    decision: params.decision,
    decisionReason: params.decisionReason,
  };
}
