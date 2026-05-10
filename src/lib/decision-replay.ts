// ============================================================
// Decision Replay Packet — P0.6 (Schema-First, Minimal)
// ------------------------------------------------------------
// Every signal/trade proposal should eventually record enough
// metadata to reconstruct the decision that was made.
//
// Current status: TYPE-ONLY. No DB column yet.
//
// Required DB migration (P1):
//   ALTER TABLE trade_signals ADD COLUMN replay_packet JSONB;
//   ALTER TABLE trades ADD COLUMN replay_packet JSONB;
//
// Safety rules enforced by this type:
//   - Do NOT store raw Coinbase credentials.
//   - Do NOT store full prompt text (store version + input hash).
//   - Do NOT store sensitive user PII.
//   - DO store enough to replay the gate logic from archived data.
// ============================================================

/** Canonical replay packet version. Increment on breaking schema changes. */
export const REPLAY_PACKET_VERSION = "1" as const;

/**
 * Doctrine state captured at decision time.
 * Enough to re-run risk gate math without re-fetching user settings.
 */
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

/**
 * Market context captured at decision time (non-sensitive summary).
 * Candle values are safe to store; broker credentials are not included.
 */
export interface MarketReplaySlice {
  symbol: string;
  regime: string;
  setupScore: number;
  confidence: number;
  volatility: string;
  brainTrustFresh: boolean;
  /** Age of the engine snapshot at decision time (seconds). */
  snapshotAgeSeconds: number;
}

/**
 * AI model metadata — enough to identify which model and prompt version
 * produced the decision, without storing the raw prompt text.
 */
export interface ModelReplaySlice {
  /** e.g. "google/gemini-3-flash-preview" */
  taylorModel: string;
  /**
   * Version hash of the Taylor prompt template (semver or git SHA prefix).
   * Store a short identifier, not the full prompt.
   */
  taylorPromptVersion: string;
  /** e.g. "anthropic/claude-sonnet-4-6" */
  riskManagerModel: string;
  /** SHA-256 of the input packet (candles + context, not credentials). */
  inputPacketHash?: string;
}

/**
 * Risk gate summary at decision time.
 * Full gate reasons list, preserving the exact codes and severities.
 */
export interface GateReplaySlice {
  gates: Array<{
    code: string;
    severity: "halt" | "block" | "skip" | "warn" | "info";
    message: string;
  }>;
  anyRefusal: boolean;
  refusalCodes: string[];
}

/**
 * Full replayable decision packet.
 *
 * Stored as JSONB in trade_signals.replay_packet (migration pending).
 * When complete, this packet allows any future session to understand
 * exactly why a trade was approved, vetoed, or skipped.
 */
export interface DecisionReplayPacket {
  /** Schema version — increment on breaking changes. */
  replayVersion: typeof REPLAY_PACKET_VERSION;
  /** ISO timestamp when this packet was created. */
  packetCreatedAt: string;
  /** The trade_signal.id or trade.id this packet belongs to. */
  signalId: string;
  /** When the signal engine ran. */
  ranAt: string;

  market: MarketReplaySlice;
  doctrine: DoctrineReplaySlice;
  model: ModelReplaySlice;
  gates: GateReplaySlice;

  /** Final decision outcome. */
  decision: "approved" | "vetoed_by_risk_manager" | "skipped_no_signal" | "blocked_by_gate";
  /** Human-readable reason for the decision. */
  decisionReason: string;

  // ── Populated post-trade by Wendy ────────────────────────────────────────
  /** Actual trade outcome — filled in after close by post-trade-learn. */
  actualOutcome?: "win" | "loss" | "breakeven" | "open" | "cancelled";
  /** Wendy's grade for this decision. */
  wendyGrade?: "A" | "B" | "C" | "D" | "F";
  /** ISO timestamp when outcome was recorded. */
  outcomeRecordedAt?: string;
}

/**
 * Builds a minimal DecisionReplayPacket from available signal data.
 * Fields that require post-trade data (outcome, grade) are omitted.
 */
export function buildDecisionReplayPacket(params: {
  signalId: string;
  ranAt: string;
  market: MarketReplaySlice;
  doctrine: DoctrineReplaySlice;
  model: ModelReplaySlice;
  gates: GateReplaySlice;
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
    decision: params.decision,
    decisionReason: params.decisionReason,
  };
}
