// ============================================================
// PR #39 — Strategy Learning Consumer tests
// ============================================================
// Covers all safety and correctness requirements:
//
// Part A — Replay packet side population:
//   1.  MarketReplaySlice accepts side field.
//   2.  buildDecisionReplayPacket preserves side when provided.
//   3.  buildDecisionReplayPacket side is optional (not guessed when absent).
//   4.  Replay packet without side leaves side undefined (not defaulted to "long").
//
// Part C — Evidence grouping:
//   5.  groupEvidence skips insufficient_data results.
//   6.  groupEvidence skips no_clear_edge results.
//   7.  groupEvidence skips ignore_insufficient_data actions.
//   8.  groupEvidence groups by (user, symbol, strategy, regime, reason, action).
//   9.  groupEvidence counts would_have_won and would_have_lost correctly.
//  10.  Different users produce separate groups.
//
// Safety classification:
//  11.  Safety blocks → REINFORCE_BLOCKER only (never QUESTION_BLOCKER).
//  12.  Safety blocks → REINFORCE_BLOCKER only (never TUNE_THRESHOLD).
//  13.  KILL_SWITCH_ACTIVE + would_have_won → REINFORCE_BLOCKER.
//  14.  DAILY_LOSS_CAP_REACHED + would_have_won → REINFORCE_BLOCKER.
//  15.  ACCOUNT_FLOOR_BREACHED + would_have_won → REINFORCE_BLOCKER.
//  16.  KILL_SWITCH_ACTIVE → recommendation text includes "safety invariant".
//
// Actionable recommendations:
//  17.  LOW_CONFIDENCE + repeated would_have_won → TUNE_THRESHOLD (strong sample).
//  18.  COACH_PENALTY + repeated would_have_won → QUESTION_BLOCKER.
//  19.  RISK_MANAGER_VETO + repeated would_have_won → QUESTION_BLOCKER.
//  20.  LOW_CONFIDENCE + repeated would_have_lost → REINFORCE_BLOCKER.
//  21.  COACH_PENALTY + repeated would_have_lost → REINFORCE_BLOCKER.
//
// Insufficient evidence:
//  22.  Sample below MIN_EVIDENCE_COUNT → INSUFFICIENT_EVIDENCE.
//  23.  Confidence below MIN_ACTIONABLE_CONFIDENCE → INSUFFICIENT_EVIDENCE.
//  24.  INSUFFICIENT_EVIDENCE recommendation does not mutate strategies.
//
// Confidence scoring:
//  25.  scoreConfidence is 0 for empty group.
//  26.  scoreConfidence applies Laplace smoothing.
//  27.  scoreConfidence applies size discount for small samples.
//  28.  scoreConfidence returns value in [0, 1].
//
// Sample quality:
//  29.  scoreSampleQuality: < 5 → "insufficient".
//  30.  scoreSampleQuality: 5–9 → "weak".
//  31.  scoreSampleQuality: 10–19 → "moderate".
//  32.  scoreSampleQuality: ≥ 20 → "strong".
//
// buildRecommendation safety:
//  33.  Recommendations are proposal-only (status = "pending_review").
//  34.  Recommendations do not mutate strategies (structural proof).
//  35.  Recommendations do not mutate doctrine (structural proof).
//  36.  Recommendations do not approve signals (structural proof).
//  37.  Recommendations do not create trades (structural proof).
//
// buildAllRecommendations:
//  38.  Returns one recommendation per group.
//  39.  All recommendations default to pending_review.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  buildDecisionReplayPacket,
  type MarketReplaySlice,
} from "@/lib/decision-replay";
import {
  groupEvidence,
  classifyGroup,
  scoreConfidence,
  scoreSampleQuality,
  buildRecommendation,
  buildAllRecommendations,
  hasSafetyBlock,
  groupKeyString,
  MIN_EVIDENCE_COUNT,
  MIN_ACTIONABLE_CONFIDENCE,
  STRONG_EVIDENCE_COUNT,
  type EvidenceRow,
  type EvidenceGroup,
} from "@/lib/strategy-learning";
import type { SimulationResult } from "@/lib/outcome-enrichment";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER_A = "user-a-uuid";
const USER_B = "user-b-uuid";

function makeResult(
  label: SimulationResult["result_label"],
  action: SimulationResult["recommended_learning_action"],
): SimulationResult {
  return {
    result_label: label,
    simulated_entry_price: 50000,
    simulated_exit_price: label === "would_have_won" ? 51500 : 48500,
    lookahead_window: "1h",
    hypothetical_pnl: label === "would_have_won" ? 0.03 : -0.03,
    hypothetical_return_pct: label === "would_have_won" ? 0.03 : -0.03,
    max_adverse_excursion: label === "would_have_won" ? -0.005 : -0.04,
    max_favorable_excursion: label === "would_have_won" ? 0.035 : 0.01,
    recommended_learning_action: action,
    enriched_at: new Date().toISOString(),
    insufficient_data_reason: label === "insufficient_data" ? "missing_side" : null,
    simulated_side: "long",
  };
}

function makeRow(
  overrides: Partial<EvidenceRow> & { result: SimulationResult },
): EvidenceRow {
  return {
    id: `sim-${Math.random().toString(36).slice(2)}`,
    user_id: USER_A,
    decision_memory_id: `dm-${Math.random().toString(36).slice(2)}`,
    symbol: "BTC-USD",
    strategy_id: null,
    market_regime: "trending_up",
    reason_code: "LOW_CONFIDENCE",
    blocker_codes: ["LOW_CONFIDENCE"],
    ...overrides,
  };
}

function makeGroup(
  overrides: {
    reason_code?: string;
    blocker_codes?: string[];
    user_id?: string;
    won?: number;
    lost?: number;
    action?: SimulationResult["recommended_learning_action"];
  } = {},
): EvidenceGroup {
  const {
    reason_code = "LOW_CONFIDENCE",
    blocker_codes = ["LOW_CONFIDENCE"],
    user_id = USER_A,
    won = 0,
    lost = 0,
    action = "reinforce_block",
  } = overrides;

  const rows: EvidenceRow[] = [];
  for (let i = 0; i < won; i++) {
    rows.push(
      makeRow({
        user_id,
        reason_code,
        blocker_codes,
        result: makeResult("would_have_won", action),
      }),
    );
  }
  for (let i = 0; i < lost; i++) {
    rows.push(
      makeRow({
        user_id,
        reason_code,
        blocker_codes,
        result: makeResult("would_have_lost", action),
      }),
    );
  }

  return {
    key: {
      user_id,
      symbol: "BTC-USD",
      strategy_id: null,
      market_regime: "trending_up",
      reason_code,
      recommended_learning_action: action,
      blocker_codes,
    },
    rows,
    wouldHaveWon: won,
    wouldHaveLost: lost,
    totalActionable: won + lost,
  };
}

// ─── Part A: Replay packet side ───────────────────────────────────────────────

describe("Part A — replay packet side population", () => {
  const baseDoctrine = {
    mode: "paper" as const,
    dailyLossCapUsd: 2,
    killSwitchFloorUsd: 8,
    maxTradesPerDay: 5,
    maxOrderPct: 0.001,
    maxOrderAbsCap: 1,
    dailyLossPct: 0.02,
    floorPct: 0.8,
    profile: "sentinel" as const,
  };
  const baseModel = {
    taylorModel: "google/gemini-3-flash-preview",
    taylorPromptVersion: "v2",
    riskManagerModel: "google/gemini-3-flash-preview",
  };
  const baseGates = { gates: [], anyRefusal: false, refusalCodes: [] };

  it("1. MarketReplaySlice accepts side field", () => {
    const market: MarketReplaySlice = {
      symbol: "BTC-USD",
      regime: "trending_up",
      setupScore: 0.7,
      confidence: 0.65,
      volatility: "medium",
      brainTrustFresh: true,
      brainTrustAgeMinutes: 45,
      snapshotAgeSeconds: 120,
      side: "long",
    };
    expect(market.side).toBe("long");
  });

  it("2. buildDecisionReplayPacket preserves side when provided", () => {
    const market: MarketReplaySlice = {
      symbol: "BTC-USD",
      regime: "trending_up",
      setupScore: 0.7,
      confidence: 0.65,
      volatility: "medium",
      brainTrustFresh: true,
      brainTrustAgeMinutes: 45,
      snapshotAgeSeconds: 120,
      side: "short",
    };
    const packet = buildDecisionReplayPacket({
      signalId: "test-1",
      ranAt: new Date().toISOString(),
      market,
      doctrine: baseDoctrine,
      model: baseModel,
      gates: baseGates,
      decision: "approved",
      decisionReason: "test",
    });
    expect(packet.market.side).toBe("short");
  });

  it("3. buildDecisionReplayPacket side field is optional — not required", () => {
    const market: MarketReplaySlice = {
      symbol: "BTC-USD",
      regime: "trending_up",
      setupScore: 0.7,
      confidence: 0.65,
      volatility: "medium",
      brainTrustFresh: true,
      brainTrustAgeMinutes: 45,
      snapshotAgeSeconds: 120,
      // side intentionally omitted
    };
    const packet = buildDecisionReplayPacket({
      signalId: "test-2",
      ranAt: new Date().toISOString(),
      market,
      doctrine: baseDoctrine,
      model: baseModel,
      gates: baseGates,
      decision: "approved",
      decisionReason: "test",
    });
    // Side must be absent or undefined — never defaulted to "long"
    expect(packet.market.side).toBeUndefined();
  });

  it("4. Replay packet without side does not default to long", () => {
    const market: MarketReplaySlice = {
      symbol: "SOL-USD",
      regime: "ranging",
      setupScore: 0.5,
      confidence: 0.6,
      volatility: "low",
      brainTrustFresh: false,
      brainTrustAgeMinutes: null,
      snapshotAgeSeconds: 60,
    };
    const packet = buildDecisionReplayPacket({
      signalId: "test-3",
      ranAt: new Date().toISOString(),
      market,
      doctrine: baseDoctrine,
      model: baseModel,
      gates: baseGates,
      decision: "vetoed_by_risk_manager",
      decisionReason: "no side provided",
    });
    expect(packet.market.side).not.toBe("long");
    expect(packet.market.side).not.toBe("short");
  });
});

// ─── Part C: Evidence grouping ────────────────────────────────────────────────

describe("Part C — evidence grouping", () => {
  it("5. groupEvidence skips insufficient_data results", () => {
    const rows = [
      makeRow({ result: makeResult("insufficient_data", "ignore_insufficient_data") }),
      makeRow({ result: makeResult("insufficient_data", "ignore_insufficient_data") }),
    ];
    const groups = groupEvidence(rows);
    expect(groups).toHaveLength(0);
  });

  it("6. groupEvidence skips no_clear_edge results", () => {
    const rows = [
      makeRow({ result: makeResult("no_clear_edge", "ignore_insufficient_data") }),
    ];
    const groups = groupEvidence(rows);
    expect(groups).toHaveLength(0);
  });

  it("7. groupEvidence skips ignore_insufficient_data actions", () => {
    // Even if label is actionable, ignore_insufficient_data action is filtered
    const result: SimulationResult = {
      ...makeResult("would_have_won", "ignore_insufficient_data"),
    };
    const rows = [makeRow({ result })];
    const groups = groupEvidence(rows);
    expect(groups).toHaveLength(0);
  });

  it("8. groupEvidence groups by key dimensions", () => {
    const winResult = makeResult("would_have_won", "tune_threshold");
    const rows = [
      makeRow({ symbol: "BTC-USD", reason_code: "LOW_CONFIDENCE", blocker_codes: ["LOW_CONFIDENCE"], result: winResult }),
      makeRow({ symbol: "BTC-USD", reason_code: "LOW_CONFIDENCE", blocker_codes: ["LOW_CONFIDENCE"], result: winResult }),
      makeRow({ symbol: "ETH-USD", reason_code: "LOW_CONFIDENCE", blocker_codes: ["LOW_CONFIDENCE"], result: winResult }),
    ];
    const groups = groupEvidence(rows);
    // BTC + ETH should be separate groups
    expect(groups).toHaveLength(2);
    const btcGroup = groups.find((g) => g.key.symbol === "BTC-USD");
    expect(btcGroup?.totalActionable).toBe(2);
  });

  it("9. groupEvidence counts would_have_won and would_have_lost correctly", () => {
    const rows = [
      makeRow({ reason_code: "COACH_PENALTY", blocker_codes: ["COACH_PENALTY"], result: makeResult("would_have_won", "question_block") }),
      makeRow({ reason_code: "COACH_PENALTY", blocker_codes: ["COACH_PENALTY"], result: makeResult("would_have_won", "question_block") }),
      makeRow({ reason_code: "COACH_PENALTY", blocker_codes: ["COACH_PENALTY"], result: makeResult("would_have_lost", "reinforce_block") }),
    ];
    // Note: won and lost have different actions so they group separately
    const groups = groupEvidence(rows);
    const wonGroup = groups.find((g) => g.key.recommended_learning_action === "question_block");
    const lostGroup = groups.find((g) => g.key.recommended_learning_action === "reinforce_block");
    expect(wonGroup?.wouldHaveWon).toBe(2);
    expect(wonGroup?.wouldHaveLost).toBe(0);
    expect(lostGroup?.wouldHaveLost).toBe(1);
    expect(lostGroup?.wouldHaveWon).toBe(0);
  });

  it("10. Different users produce separate groups", () => {
    const result = makeResult("would_have_won", "tune_threshold");
    const rows = [
      makeRow({ user_id: USER_A, result }),
      makeRow({ user_id: USER_B, result }),
    ];
    const groups = groupEvidence(rows);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.key.user_id).sort()).toEqual([USER_A, USER_B].sort());
  });
});

// ─── Safety classification ────────────────────────────────────────────────────

describe("Safety classification — safety blocks", () => {
  const SAFETY_CODES = [
    "KILL_SWITCH_ACTIVE",
    "DAILY_LOSS_CAP_REACHED",
    "ACCOUNT_FLOOR_BREACHED",
    "MAX_TRADES_REACHED",
    "COOLDOWN_ACTIVE",
    "DOCTRINE_BLOCK",
    "RISK_GATE_BLOCK",
  ];

  it("11. Safety blocks → REINFORCE_BLOCKER only (never QUESTION_BLOCKER)", () => {
    for (const code of SAFETY_CODES) {
      const group = makeGroup({ reason_code: code, blocker_codes: [code], won: 20, lost: 2, action: "reinforce_block" });
      const type = classifyGroup(group);
      expect(type).toBe("REINFORCE_BLOCKER");
      expect(type).not.toBe("QUESTION_BLOCKER");
    }
  });

  it("12. Safety blocks → REINFORCE_BLOCKER only (never TUNE_THRESHOLD)", () => {
    for (const code of SAFETY_CODES) {
      const group = makeGroup({ reason_code: code, blocker_codes: [code], won: 20, lost: 0, action: "reinforce_block" });
      const type = classifyGroup(group);
      expect(type).not.toBe("TUNE_THRESHOLD");
    }
  });

  it("13. KILL_SWITCH_ACTIVE + would_have_won → REINFORCE_BLOCKER", () => {
    const group = makeGroup({ reason_code: "KILL_SWITCH_ACTIVE", blocker_codes: ["KILL_SWITCH_ACTIVE"], won: 15, lost: 2, action: "reinforce_block" });
    expect(classifyGroup(group)).toBe("REINFORCE_BLOCKER");
  });

  it("14. DAILY_LOSS_CAP_REACHED + would_have_won → REINFORCE_BLOCKER", () => {
    const group = makeGroup({ reason_code: "DAILY_LOSS_CAP_REACHED", blocker_codes: ["DAILY_LOSS_CAP_REACHED"], won: 10, lost: 0, action: "reinforce_block" });
    expect(classifyGroup(group)).toBe("REINFORCE_BLOCKER");
  });

  it("15. ACCOUNT_FLOOR_BREACHED + would_have_won → REINFORCE_BLOCKER", () => {
    const group = makeGroup({ reason_code: "ACCOUNT_FLOOR_BREACHED", blocker_codes: ["ACCOUNT_FLOOR_BREACHED"], won: 8, lost: 1, action: "reinforce_block" });
    expect(classifyGroup(group)).toBe("REINFORCE_BLOCKER");
  });

  it("16. KILL_SWITCH recommendation text includes safety invariant language", () => {
    const group = makeGroup({ reason_code: "KILL_SWITCH_ACTIVE", blocker_codes: ["KILL_SWITCH_ACTIVE"], won: 5, lost: 3, action: "reinforce_block" });
    const rec = buildRecommendation(group);
    expect(rec.recommendation).toContain("safety invariant");
    expect(rec.recommendation_type).toBe("REINFORCE_BLOCKER");
  });

  it("hasSafetyBlock: returns true for any safety code in array", () => {
    expect(hasSafetyBlock(["LOW_CONFIDENCE", "KILL_SWITCH_ACTIVE"])).toBe(true);
    expect(hasSafetyBlock(["LOW_CONFIDENCE", "COACH_PENALTY"])).toBe(false);
    expect(hasSafetyBlock([])).toBe(false);
  });
});

// ─── Actionable recommendations ───────────────────────────────────────────────

describe("Actionable recommendations", () => {
  it("17. LOW_CONFIDENCE + strong repeated would_have_won → TUNE_THRESHOLD", () => {
    // 20 wins, 2 losses → high confidence → TUNE_THRESHOLD
    const group = makeGroup({
      reason_code: "LOW_CONFIDENCE",
      blocker_codes: ["LOW_CONFIDENCE"],
      won: 20,
      lost: 2,
      action: "tune_threshold",
    });
    expect(classifyGroup(group)).toBe("TUNE_THRESHOLD");
  });

  it("18. COACH_PENALTY + strong repeated would_have_won → QUESTION_BLOCKER", () => {
    const group = makeGroup({
      reason_code: "COACH_PENALTY",
      blocker_codes: ["COACH_PENALTY"],
      won: 18,
      lost: 2,
      action: "question_block",
    });
    expect(classifyGroup(group)).toBe("QUESTION_BLOCKER");
  });

  it("19. RISK_MANAGER_VETO + strong repeated would_have_won → QUESTION_BLOCKER", () => {
    const group = makeGroup({
      reason_code: "RISK_MANAGER_VETO",
      blocker_codes: ["RISK_MANAGER_VETO"],
      won: 15,
      lost: 3,
      action: "question_block",
    });
    expect(classifyGroup(group)).toBe("QUESTION_BLOCKER");
  });

  it("20. LOW_CONFIDENCE + repeated would_have_lost → REINFORCE_BLOCKER", () => {
    const group = makeGroup({
      reason_code: "LOW_CONFIDENCE",
      blocker_codes: ["LOW_CONFIDENCE"],
      won: 1,
      lost: 15,
      action: "reinforce_block",
    });
    expect(classifyGroup(group)).toBe("REINFORCE_BLOCKER");
  });

  it("21. COACH_PENALTY + repeated would_have_lost → REINFORCE_BLOCKER", () => {
    const group = makeGroup({
      reason_code: "COACH_PENALTY",
      blocker_codes: ["COACH_PENALTY"],
      won: 0,
      lost: 10,
      action: "reinforce_block",
    });
    expect(classifyGroup(group)).toBe("REINFORCE_BLOCKER");
  });
});

// ─── Insufficient evidence ────────────────────────────────────────────────────

describe("Insufficient evidence guardrails", () => {
  it("22. Sample below MIN_EVIDENCE_COUNT → INSUFFICIENT_EVIDENCE", () => {
    // 4 samples (MIN_EVIDENCE_COUNT = 5) → insufficient
    const group = makeGroup({
      reason_code: "LOW_CONFIDENCE",
      blocker_codes: ["LOW_CONFIDENCE"],
      won: 4,
      lost: 0,
      action: "tune_threshold",
    });
    expect(group.totalActionable).toBe(4);
    expect(group.totalActionable).toBeLessThan(MIN_EVIDENCE_COUNT);
    expect(classifyGroup(group)).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("23. Confidence below MIN_ACTIONABLE_CONFIDENCE → INSUFFICIENT_EVIDENCE", () => {
    // 5 samples but 50/50 win/loss → low confidence
    const group = makeGroup({
      reason_code: "RISK_MANAGER_VETO",
      blocker_codes: ["RISK_MANAGER_VETO"],
      won: 3,
      lost: 2,
      action: "question_block",
    });
    const conf = scoreConfidence(group);
    expect(conf).toBeLessThan(MIN_ACTIONABLE_CONFIDENCE);
    expect(classifyGroup(group)).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("24. INSUFFICIENT_EVIDENCE recommendation is proposal-only", () => {
    const group = makeGroup({ won: 2, lost: 0, action: "tune_threshold" });
    const rec = buildRecommendation(group);
    expect(rec.recommendation_type).toBe("INSUFFICIENT_EVIDENCE");
    expect(rec.status).toBe("pending_review");
    // No strategy mutation fields
    expect(rec).not.toHaveProperty("strategy");
    expect(rec).not.toHaveProperty("doctrine");
    expect(rec).not.toHaveProperty("approved");
  });
});

// ─── Confidence scoring ───────────────────────────────────────────────────────

describe("Confidence scoring", () => {
  it("25. scoreConfidence returns 0 for empty group", () => {
    const group = makeGroup({ won: 0, lost: 0, action: "reinforce_block" });
    expect(scoreConfidence(group)).toBe(0);
  });

  it("26. scoreConfidence applies Laplace smoothing (avoids 0 or 1 for small samples)", () => {
    const group = makeGroup({ won: 5, lost: 0, action: "tune_threshold" });
    const conf = scoreConfidence(group);
    // Should not be exactly 1.0 due to smoothing
    expect(conf).toBeLessThan(1.0);
    expect(conf).toBeGreaterThan(0);
  });

  it("27. scoreConfidence applies size discount for small samples", () => {
    const smallGroup = makeGroup({ won: 5, lost: 0, action: "tune_threshold" });
    const largeGroup = makeGroup({ won: STRONG_EVIDENCE_COUNT, lost: 0, action: "tune_threshold" });
    const smallConf = scoreConfidence(smallGroup);
    const largeConf = scoreConfidence(largeGroup);
    // Large group should have higher confidence due to size discount
    expect(largeConf).toBeGreaterThan(smallConf);
  });

  it("28. scoreConfidence returns value in [0, 1]", () => {
    const groups = [
      makeGroup({ won: 0, lost: 10, action: "reinforce_block" }),
      makeGroup({ won: 10, lost: 0, action: "question_block" }),
      makeGroup({ won: 5, lost: 5, action: "tune_threshold" }),
    ];
    for (const g of groups) {
      const conf = scoreConfidence(g);
      expect(conf).toBeGreaterThanOrEqual(0);
      expect(conf).toBeLessThanOrEqual(1);
    }
  });
});

// ─── Sample quality ───────────────────────────────────────────────────────────

describe("Sample quality classification", () => {
  it("29. < 5 samples → insufficient", () => {
    expect(scoreSampleQuality(0)).toBe("insufficient");
    expect(scoreSampleQuality(1)).toBe("insufficient");
    expect(scoreSampleQuality(4)).toBe("insufficient");
  });

  it("30. 5–9 samples → weak", () => {
    expect(scoreSampleQuality(5)).toBe("weak");
    expect(scoreSampleQuality(9)).toBe("weak");
  });

  it("31. 10–19 samples → moderate", () => {
    expect(scoreSampleQuality(10)).toBe("moderate");
    expect(scoreSampleQuality(19)).toBe("moderate");
  });

  it("32. ≥ 20 samples → strong", () => {
    expect(scoreSampleQuality(20)).toBe("strong");
    expect(scoreSampleQuality(100)).toBe("strong");
  });
});

// ─── Recommendation safety ────────────────────────────────────────────────────

describe("buildRecommendation safety guarantees", () => {
  it("33. Recommendations are proposal-only (status = pending_review)", () => {
    const group = makeGroup({ won: 20, lost: 2, action: "tune_threshold", blocker_codes: ["LOW_CONFIDENCE"] });
    const rec = buildRecommendation(group);
    expect(rec.status).toBe("pending_review");
  });

  it("34. Recommendations do not mutate strategies", () => {
    const group = makeGroup({ won: 20, lost: 2, action: "tune_threshold", blocker_codes: ["LOW_CONFIDENCE"] });
    const rec = buildRecommendation(group);
    // No strategy mutation fields
    expect(rec).not.toHaveProperty("strategy_params");
    expect(rec).not.toHaveProperty("new_confidence_threshold");
    expect(rec).not.toHaveProperty("mutate");
    expect(rec).not.toHaveProperty("auto_apply");
  });

  it("35. Recommendations do not mutate doctrine", () => {
    const group = makeGroup({ won: 20, lost: 2, action: "tune_threshold", blocker_codes: ["LOW_CONFIDENCE"] });
    const rec = buildRecommendation(group);
    expect(rec).not.toHaveProperty("doctrine");
    expect(rec).not.toHaveProperty("doctrine_settings");
    expect(rec).not.toHaveProperty("dailyLossCapUsd");
  });

  it("36. Recommendations do not approve signals", () => {
    const group = makeGroup({ won: 20, lost: 0, action: "question_block", blocker_codes: ["COACH_PENALTY"] });
    const rec = buildRecommendation(group);
    expect(rec).not.toHaveProperty("signal_approved");
    expect(rec).not.toHaveProperty("approve");
    expect(rec).not.toHaveProperty("execute");
  });

  it("37. Recommendations do not create trades", () => {
    const group = makeGroup({ won: 20, lost: 0, action: "question_block", blocker_codes: ["RISK_MANAGER_VETO"] });
    const rec = buildRecommendation(group);
    expect(rec).not.toHaveProperty("trade");
    expect(rec).not.toHaveProperty("order");
    expect(rec).not.toHaveProperty("broker");
  });
});

// ─── buildAllRecommendations ──────────────────────────────────────────────────

describe("buildAllRecommendations", () => {
  it("38. Returns one recommendation per group", () => {
    const groups = [
      makeGroup({ reason_code: "LOW_CONFIDENCE", blocker_codes: ["LOW_CONFIDENCE"], won: 20, lost: 2, action: "tune_threshold" }),
      makeGroup({ reason_code: "COACH_PENALTY", blocker_codes: ["COACH_PENALTY"], won: 18, lost: 2, action: "question_block" }),
    ];
    const recs = buildAllRecommendations(groups);
    expect(recs).toHaveLength(2);
  });

  it("39. All recommendations default to pending_review", () => {
    const groups = [
      makeGroup({ reason_code: "KILL_SWITCH_ACTIVE", blocker_codes: ["KILL_SWITCH_ACTIVE"], won: 5, lost: 3, action: "reinforce_block" }),
      makeGroup({ reason_code: "LOW_CONFIDENCE", blocker_codes: ["LOW_CONFIDENCE"], won: 20, lost: 2, action: "tune_threshold" }),
    ];
    const recs = buildAllRecommendations(groups);
    for (const rec of recs) {
      expect(rec.status).toBe("pending_review");
    }
  });
});

// ─── Missing-side simulations ─────────────────────────────────────────────────

describe("Missing-side simulation handling", () => {
  it("Missing-side simulations are excluded from strategy learning groups", () => {
    // A missing_side simulation has result_label=insufficient_data
    const missingSideResult: SimulationResult = {
      result_label: "insufficient_data",
      simulated_entry_price: 50000,
      simulated_exit_price: 51000,
      lookahead_window: "1h",
      hypothetical_pnl: null,
      hypothetical_return_pct: null,
      max_adverse_excursion: null,
      max_favorable_excursion: null,
      recommended_learning_action: "ignore_insufficient_data",
      enriched_at: new Date().toISOString(),
      insufficient_data_reason: "missing_side — direction unknown, cannot score hypothetical outcome",
      simulated_side: null,
    };
    const rows = [makeRow({ result: missingSideResult })];
    const groups = groupEvidence(rows);
    expect(groups).toHaveLength(0);
  });
});

// ─── groupKeyString ───────────────────────────────────────────────────────────

describe("groupKeyString", () => {
  it("produces different strings for different group keys", () => {
    const k1 = groupKeyString({
      user_id: USER_A, symbol: "BTC-USD", strategy_id: null,
      market_regime: "trending_up", reason_code: "LOW_CONFIDENCE",
      recommended_learning_action: "tune_threshold",
    });
    const k2 = groupKeyString({
      user_id: USER_A, symbol: "ETH-USD", strategy_id: null,
      market_regime: "trending_up", reason_code: "LOW_CONFIDENCE",
      recommended_learning_action: "tune_threshold",
    });
    expect(k1).not.toBe(k2);
  });

  it("produces same string for identical keys", () => {
    const base = {
      user_id: USER_A, symbol: "BTC-USD", strategy_id: null,
      market_regime: "trending_up", reason_code: "LOW_CONFIDENCE",
      recommended_learning_action: "tune_threshold" as const,
    };
    expect(groupKeyString(base)).toBe(groupKeyString({ ...base }));
  });
});
