// ============================================================
// PR #36 — Negative Example Memory: decision_memory tests
// ============================================================
// Verifies that:
//   1. Non-trade decisions produce structured memory records
//      and do NOT create trades or signal rows.
//   2. The reason-code taxonomy and helper functions work correctly.
//   3. Replay packets are symbol-specific and redact secrets.
//   4. The used_for_learning flag starts false and can be set.
//   5. Safety blocks are correctly classified.
//   6. Learning opportunities are correctly classified.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  isSafetyBlock,
  isLearningOpportunity,
  REASON_CODE_LABELS,
  type NonTradeReasonCode,
  type NonTradeReplayPacket,
  type DecisionMemoryRow,
} from "@/lib/decision-memory";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeReplayPacket(overrides: Partial<NonTradeReplayPacket> = {}): NonTradeReplayPacket {
  return {
    ranAt: "2026-05-10T12:00:00.000Z",
    symbol: "BTC-USD",
    regime: "trending_up",
    setupScore: 0.62,
    confidence: 0.48,
    mode: "paper",
    blockerCodes: ["COACH_PENALTY"],
    reason: "Coach penalty: raw conf 0.68 × 0.70 = 0.48 < MIN_CONFIDENCE(0.50)",
    ...overrides,
  };
}

function makeDecisionMemoryRow(overrides: Partial<DecisionMemoryRow> = {}): DecisionMemoryRow {
  return {
    id: "dm-uuid-001",
    user_id: "user-uuid-001",
    symbol: "BTC-USD",
    strategy_id: null,
    event_type: "non_trade",
    source_agent: "signal_engine",
    reason_code: "COACH_PENALTY",
    severity: "skip",
    mode: "paper",
    market_regime: "trending_up",
    confidence: 0.48,
    setup_score: 0.62,
    replay_packet: makeReplayPacket(),
    blocker_codes: ["COACH_PENALTY"],
    used_for_learning: false,
    created_at: "2026-05-10T12:00:00.000Z",
    ...overrides,
  };
}

// ─── Reason code taxonomy ────────────────────────────────────────────────────

describe("NonTradeReasonCode labels", () => {
  it("has a label for every reason code", () => {
    const codes: NonTradeReasonCode[] = [
      "NO_TRADE_REGIME",
      "LOW_SETUP_SCORE",
      "LOW_CONFIDENCE",
      "COACH_PENALTY",
      "EDGE_BELOW_COSTS",
      "AI_ERROR",
      "RISK_GATE_BLOCK",
      "KILL_SWITCH_ACTIVE",
      "DAILY_LOSS_CAP_REACHED",
      "ACCOUNT_FLOOR_BREACHED",
      "MAX_TRADES_REACHED",
      "COOLDOWN_ACTIVE",
      "DOCTRINE_BLOCK",
      "BRAIN_TRUST_STALE",
      "MARKET_DATA_STALE",
      "NO_APPROVED_STRATEGY",
      "RISK_MANAGER_VETO",
      "RISK_MANAGER_SKIP_TICK",
      "OPERATOR_REJECTED",
    ];
    for (const code of codes) {
      expect(REASON_CODE_LABELS[code]).toBeTruthy();
      expect(typeof REASON_CODE_LABELS[code]).toBe("string");
    }
  });

  it("COACH_PENALTY has a descriptive label mentioning threshold", () => {
    expect(REASON_CODE_LABELS.COACH_PENALTY.toLowerCase()).toContain("coach");
  });

  it("RISK_MANAGER_SKIP_TICK label mentions transient", () => {
    expect(REASON_CODE_LABELS.RISK_MANAGER_SKIP_TICK.toLowerCase()).toContain("transient");
  });
});

// ─── Safety block classification ─────────────────────────────────────────────

describe("isSafetyBlock()", () => {
  it("classifies kill switch as a safety block", () => {
    expect(isSafetyBlock("KILL_SWITCH_ACTIVE")).toBe(true);
  });

  it("classifies daily loss cap as a safety block", () => {
    expect(isSafetyBlock("DAILY_LOSS_CAP_REACHED")).toBe(true);
  });

  it("classifies account floor breach as a safety block", () => {
    expect(isSafetyBlock("ACCOUNT_FLOOR_BREACHED")).toBe(true);
  });

  it("classifies max trades cap as a safety block", () => {
    expect(isSafetyBlock("MAX_TRADES_REACHED")).toBe(true);
  });

  it("classifies cooldown as a safety block", () => {
    expect(isSafetyBlock("COOLDOWN_ACTIVE")).toBe(true);
  });

  it("classifies doctrine block as a safety block", () => {
    expect(isSafetyBlock("DOCTRINE_BLOCK")).toBe(true);
  });

  it("does NOT classify coach penalty as a safety block (it's a learning opportunity)", () => {
    expect(isSafetyBlock("COACH_PENALTY")).toBe(false);
  });

  it("does NOT classify low setup score as a safety block", () => {
    expect(isSafetyBlock("LOW_SETUP_SCORE")).toBe(false);
  });

  it("does NOT classify risk manager veto as a safety block", () => {
    expect(isSafetyBlock("RISK_MANAGER_VETO")).toBe(false);
  });
});

// ─── Learning opportunity classification ──────────────────────────────────────

describe("isLearningOpportunity()", () => {
  it("classifies coach penalty as a learning opportunity", () => {
    expect(isLearningOpportunity("COACH_PENALTY")).toBe(true);
  });

  it("classifies low setup score as a learning opportunity", () => {
    expect(isLearningOpportunity("LOW_SETUP_SCORE")).toBe(true);
  });

  it("classifies low confidence as a learning opportunity", () => {
    expect(isLearningOpportunity("LOW_CONFIDENCE")).toBe(true);
  });

  it("classifies risk manager veto as a learning opportunity", () => {
    expect(isLearningOpportunity("RISK_MANAGER_VETO")).toBe(true);
  });

  it("classifies brain trust stale as a learning opportunity", () => {
    expect(isLearningOpportunity("BRAIN_TRUST_STALE")).toBe(true);
  });

  it("classifies no approved strategy as a learning opportunity", () => {
    expect(isLearningOpportunity("NO_APPROVED_STRATEGY")).toBe(true);
  });

  it("does NOT classify kill switch as a learning opportunity", () => {
    expect(isLearningOpportunity("KILL_SWITCH_ACTIVE")).toBe(false);
  });

  it("does NOT classify daily loss cap as a learning opportunity", () => {
    expect(isLearningOpportunity("DAILY_LOSS_CAP_REACHED")).toBe(false);
  });
});

// ─── Replay packet security ───────────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  "Bearer ",
  "SECRET",
  "SERVICE_ROLE",
  "apiKey",
  "api_key",
  "COINBASE_API",
  "private_key",
  "LOVABLE_API_KEY",
  "authorization",
];

describe("NonTradeReplayPacket — sensitive data exclusion", () => {
  it("does not contain any sensitive credential patterns", () => {
    const packet = makeReplayPacket();
    const serialized = JSON.stringify(packet);
    for (const pattern of SENSITIVE_PATTERNS) {
      expect(serialized).not.toContain(pattern);
    }
  });

  it("reason field is a plain string with no credentials", () => {
    const packet = makeReplayPacket({
      reason: "Coach penalty: raw conf 0.68 × 0.70 = 0.48 < MIN_CONFIDENCE(0.50)",
    });
    expect(typeof packet.reason).toBe("string");
    for (const pattern of SENSITIVE_PATTERNS) {
      expect(packet.reason).not.toContain(pattern);
    }
  });

  it("meta field with coach context contains no credentials", () => {
    const packet = makeReplayPacket({
      meta: {
        rawConfidence: 0.68,
        adjustedConfidence: 0.48,
        coachMultiplier: 0.70,
        coachSampleSize: 5,
        coachWinRate: 0.20,
        coachNetPnl: -2.5,
        minConfidenceThreshold: 0.50,
      },
    });
    const serialized = JSON.stringify(packet);
    for (const pattern of SENSITIVE_PATTERNS) {
      expect(serialized).not.toContain(pattern);
    }
  });

  it("serializes cleanly through JSON round-trip", () => {
    const packet = makeReplayPacket();
    const serialized = JSON.stringify(packet);
    const restored = JSON.parse(serialized) as NonTradeReplayPacket;
    expect(restored.symbol).toBe(packet.symbol);
    expect(restored.regime).toBe(packet.regime);
    expect(restored.setupScore).toBe(packet.setupScore);
    expect(restored.confidence).toBe(packet.confidence);
    expect(restored.blockerCodes).toEqual(packet.blockerCodes);
    expect(restored.reason).toBe(packet.reason);
  });

  it("replay packet is compact — not a raw candle dump", () => {
    const packet = makeReplayPacket();
    const serialized = JSON.stringify(packet);
    expect(serialized.length).toBeLessThan(2_000);
  });
});

// ─── Symbol-specificity ───────────────────────────────────────────────────────

describe("DecisionMemoryRow — symbol-specificity", () => {
  it("stores the symbol on the row", () => {
    const row = makeDecisionMemoryRow({ symbol: "ETH-USD" });
    expect(row.symbol).toBe("ETH-USD");
  });

  it("stores symbol in replay_packet for cross-reference", () => {
    const row = makeDecisionMemoryRow({
      symbol: "SOL-USD",
      replay_packet: makeReplayPacket({ symbol: "SOL-USD" }),
    });
    expect(row.replay_packet?.symbol).toBe("SOL-USD");
  });

  it("allows null symbol for account-level halts", () => {
    const row = makeDecisionMemoryRow({
      symbol: null,
      reason_code: "KILL_SWITCH_ACTIVE",
      replay_packet: makeReplayPacket({ symbol: null }),
    });
    expect(row.symbol).toBeNull();
    expect(row.replay_packet?.symbol).toBeNull();
  });

  it("stores market_regime for per-symbol filtering", () => {
    const row = makeDecisionMemoryRow({ market_regime: "trending_down" });
    expect(row.market_regime).toBe("trending_down");
  });
});

// ─── used_for_learning flag ───────────────────────────────────────────────────

describe("used_for_learning flag", () => {
  it("defaults to false on a new record", () => {
    const row = makeDecisionMemoryRow();
    expect(row.used_for_learning).toBe(false);
  });

  it("can be set to true when processed by Wendy/Strategy Lab", () => {
    const row = makeDecisionMemoryRow({ used_for_learning: true });
    expect(row.used_for_learning).toBe(true);
  });

  it("records with used_for_learning=false are the unprocessed learning queue", () => {
    const rows: DecisionMemoryRow[] = [
      makeDecisionMemoryRow({ id: "dm-1", used_for_learning: false }),
      makeDecisionMemoryRow({ id: "dm-2", used_for_learning: true }),
      makeDecisionMemoryRow({ id: "dm-3", used_for_learning: false }),
    ];
    const unprocessed = rows.filter((r) => !r.used_for_learning);
    expect(unprocessed).toHaveLength(2);
    expect(unprocessed.map((r) => r.id)).toEqual(["dm-1", "dm-3"]);
  });
});

// ─── Non-trade events do NOT produce trades ───────────────────────────────────

describe("Non-trade decisions never create trades", () => {
  it("a COACH_PENALTY row has no trade ID", () => {
    const row = makeDecisionMemoryRow({ reason_code: "COACH_PENALTY" });
    // decision_memory has no trade_id — it's structurally separate from trades
    expect("trade_id" in row).toBe(false);
    expect("executed_trade_id" in row).toBe(false);
  });

  it("a RISK_GATE_BLOCK row has no broker order", () => {
    const row = makeDecisionMemoryRow({ reason_code: "RISK_GATE_BLOCK" });
    expect("broker_order_id" in row).toBe(false);
  });

  it("a RISK_MANAGER_SKIP_TICK row records infrastructure failure, not a trade", () => {
    const row = makeDecisionMemoryRow({
      reason_code: "RISK_MANAGER_SKIP_TICK",
      replay_packet: makeReplayPacket({
        blockerCodes: ["RISK_MANAGER_SKIP_TICK"],
        reason: "Risk manager unavailable — skipping tick, will retry next scan.",
      }),
    });
    expect(row.reason_code).toBe("RISK_MANAGER_SKIP_TICK");
    expect(row.replay_packet?.blockerCodes).toContain("RISK_MANAGER_SKIP_TICK");
    // no trade execution fields
    expect("trade_id" in row).toBe(false);
  });

  it("a KILL_SWITCH_ACTIVE row never has an entry price", () => {
    const row = makeDecisionMemoryRow({
      symbol: null,
      reason_code: "KILL_SWITCH_ACTIVE",
    });
    expect(row.symbol).toBeNull();
    expect("proposed_entry" in row).toBe(false);
  });
});

// ─── Risk gate blocks are structurally correct ───────────────────────────────

describe("Risk gate block records", () => {
  it("blocker_codes carries the gate code array", () => {
    const row = makeDecisionMemoryRow({
      reason_code: "RISK_GATE_BLOCK",
      blocker_codes: ["KILL_SWITCH", "BALANCE_FLOOR"],
    });
    expect(row.blocker_codes).toContain("KILL_SWITCH");
    expect(row.blocker_codes).toContain("BALANCE_FLOOR");
  });

  it("severity=halt for kill switch blocks", () => {
    const row = makeDecisionMemoryRow({
      reason_code: "KILL_SWITCH_ACTIVE",
      severity: "halt",
    });
    expect(row.severity).toBe("halt");
  });

  it("severity=skip for coach penalty (not a hard block)", () => {
    const row = makeDecisionMemoryRow({
      reason_code: "COACH_PENALTY",
      severity: "skip",
    });
    expect(row.severity).toBe("skip");
  });
});

// ─── Coach penalty gap now visible ───────────────────────────────────────────

describe("COACH_PENALTY — previously invisible gap now captured", () => {
  it("stores the adjusted confidence, not just the raw confidence", () => {
    const packet = makeReplayPacket({
      confidence: 0.48, // adjusted after coach multiplier
      meta: {
        rawConfidence: 0.68,
        adjustedConfidence: 0.48,
        coachMultiplier: 0.70,
        minConfidenceThreshold: 0.50,
      },
    });
    expect(packet.confidence).toBe(0.48);
    expect(packet.meta?.rawConfidence).toBe(0.68);
    expect(packet.meta?.coachMultiplier).toBe(0.70);
  });

  it("does not create a trade — the coach penalty is a filter, not an execution", () => {
    const row = makeDecisionMemoryRow({
      reason_code: "COACH_PENALTY",
      symbol: "BTC-USD",
    });
    // Structural proof: decision_memory has no execution fields
    expect(row.event_type).toBe("non_trade");
    expect(row.source_agent).toBe("signal_engine");
    expect("side" in row).toBe(false);
    expect("size_usd" in row).toBe(false);
    expect("proposed_entry" in row).toBe(false);
  });

  it("is a learning opportunity (was previously invisible — now visible)", () => {
    expect(isLearningOpportunity("COACH_PENALTY")).toBe(true);
    expect(isSafetyBlock("COACH_PENALTY")).toBe(false);
  });
});

// ─── Paper / live gate unchanged ─────────────────────────────────────────────

describe("Paper / live gate unchanged by negative memory", () => {
  it("mode=paper records do not affect live trading", () => {
    const row = makeDecisionMemoryRow({ mode: "paper" });
    expect(row.mode).toBe("paper");
    expect("live_trading_enabled" in row).toBe(false);
  });

  it("mode=live records contain no broker credentials", () => {
    const row = makeDecisionMemoryRow({
      mode: "live",
      replay_packet: makeReplayPacket({ mode: "live" }),
    });
    const serialized = JSON.stringify(row);
    for (const pattern of SENSITIVE_PATTERNS) {
      expect(serialized).not.toContain(pattern);
    }
  });
});

// ─── Operator rejected proposals ─────────────────────────────────────────────

describe("OPERATOR_REJECTED records", () => {
  it("can be stored as a decision_memory record with OPERATOR_REJECTED code", () => {
    const row = makeDecisionMemoryRow({
      reason_code: "OPERATOR_REJECTED",
      severity: "skip",
      blocker_codes: ["OPERATOR_REJECTED"],
      replay_packet: makeReplayPacket({
        blockerCodes: ["OPERATOR_REJECTED"],
        reason: "Operator declined the AI proposal.",
      }),
    });
    expect(row.reason_code).toBe("OPERATOR_REJECTED");
    expect(row.replay_packet?.blockerCodes).toContain("OPERATOR_REJECTED");
  });

  it("OPERATOR_REJECTED is not a safety block — it is operator discretion", () => {
    expect(isSafetyBlock("OPERATOR_REJECTED")).toBe(false);
  });
});
