// ============================================================
// PR #38 — Outcome Enrichment + Wendy Loop tests
// ============================================================
// Covers all required safety and correctness cases:
//
//   1. Forward candle enrichment computes hypothetical return.
//   2. Missing candles returns insufficient_data.
//   3. COACH_PENALTY + would_have_won → question_block.
//   4. COACH_PENALTY + would_have_lost → reinforce_block.
//   5. LOW_CONFIDENCE + would_have_won → tune_threshold.
//   6. LOW_CONFIDENCE + would_have_lost → reinforce_block.
//   7. KILL_SWITCH_ACTIVE → reinforce_block even if hypothetical is profitable.
//   8. DAILY_LOSS_CAP_REACHED → reinforce_block even if hypothetical is profitable.
//   9. ACCOUNT_FLOOR_BREACHED → reinforce_block even if hypothetical is profitable.
//  10. RISK_MANAGER_VETO + would_have_won → question_block.
//  11. RISK_MANAGER_VETO + would_have_lost → reinforce_block.
//  12. no_clear_edge → ignore_insufficient_data.
//  13. insufficient_data → ignore_insufficient_data.
//  14. Safety + non-safety mixed: safety wins.
//  15. Enrichment does not create trades (structural type proof).
//  16. Enrichment does not approve signals (structural type proof).
//  17. Enrichment does not alter doctrine (structural type proof).
//  18. Replay packet patch excludes secrets.
//  19. Post-trade learning assigns correct Wendy grades.
//  20. deriveWendyGrade edge cases.
//  21. simulationSummary display helpers.
//  22. isActionable and suggestsReview helpers.
//  --- Direction-aware tests (PR #38 hardening) ---
//  23. Long + price up → would_have_won.
//  24. Long + price down → would_have_lost.
//  25. Short + price down → would_have_won.
//  26. Short + price up → would_have_lost.
//  27. Short MFE: price fell → MFE ≥ 0.
//  28. Short MAE: price rose → MAE ≤ 0.
//  29. Long MFE: price rose → MFE ≥ 0.
//  30. Long MAE: price fell → MAE ≤ 0.
//  31. Missing side → insufficient_data (not question_block / tune_threshold).
//  32. Missing side → prices recorded where candles available.
//  33. Safety block + profitable short → reinforce_block.
//  34. Safety block + profitable long → reinforce_block.
//  35. simulated_side field reflects direction used.
// ============================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  classifyLearningAction,
  hasSafetyBlock,
  deriveWendyGrade,
  buildReplayPacketOutcomePatch,
  enrichDecisionMemorySimulation,
  MIN_ENRICHMENT_AGE_SECONDS,
  type LookaheadWindow,
  type SimulationResultLabel,
  type LearningAction,
} from "@/lib/outcome-enrichment";
import {
  isActionable,
  suggestsReview,
  simulationSummary,
  RESULT_LABEL_DISPLAY,
  LEARNING_ACTION_DISPLAY,
  type SimulationResult,
} from "@/lib/outcome-enrichment";

// ─── Re-export the server-side functions for testing ─────────────────────────
// Since the _shared edition is Deno-only, we mirror the pure logic in
// src/lib/outcome-enrichment.ts so tests run in Node/Vitest.
// The browser-side module exports the same pure functions.
// (In production, the edge function imports from _shared; tests use src/lib.)

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSimulationResult(
  overrides: Partial<SimulationResult> = {},
): SimulationResult {
  return {
    result_label: "would_have_won",
    simulated_entry_price: 100_000,
    simulated_exit_price: 101_500,
    lookahead_window: "1h",
    hypothetical_pnl: 0.015,
    hypothetical_return_pct: 0.015,
    max_adverse_excursion: -0.002,
    max_favorable_excursion: 0.02,
    recommended_learning_action: "question_block",
    enriched_at: "2026-05-10T14:00:00.000Z",
    insufficient_data_reason: null,
    simulated_side: "long",
    ...overrides,
  };
}

/** Candle format: [time, low, high, open, close, volume] newest-first (Coinbase). */
function mockFetch(candles: number[][]) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => candles,
  } as unknown as Response);
}

function oldDecisionTime(lookahead: LookaheadWindow = "1h"): string {
  return new Date(
    Date.now() - MIN_ENRICHMENT_AGE_SECONDS[lookahead] * 1000 - 60_000,
  ).toISOString();
}

// ─── 1–2: classifyLearningAction — non-safety blocks ─────────────────────────

describe("classifyLearningAction — COACH_PENALTY", () => {
  it("COACH_PENALTY + would_have_won → question_block", () => {
    expect(
      classifyLearningAction(["COACH_PENALTY"], "would_have_won"),
    ).toBe("question_block");
  });

  it("COACH_PENALTY + would_have_lost → reinforce_block", () => {
    expect(
      classifyLearningAction(["COACH_PENALTY"], "would_have_lost"),
    ).toBe("reinforce_block");
  });

  it("COACH_PENALTY + no_clear_edge → ignore_insufficient_data", () => {
    expect(
      classifyLearningAction(["COACH_PENALTY"], "no_clear_edge"),
    ).toBe("ignore_insufficient_data");
  });

  it("COACH_PENALTY + insufficient_data → ignore_insufficient_data", () => {
    expect(
      classifyLearningAction(["COACH_PENALTY"], "insufficient_data"),
    ).toBe("ignore_insufficient_data");
  });
});

describe("classifyLearningAction — LOW_CONFIDENCE", () => {
  it("LOW_CONFIDENCE + would_have_won → tune_threshold", () => {
    expect(
      classifyLearningAction(["LOW_CONFIDENCE"], "would_have_won"),
    ).toBe("tune_threshold");
  });

  it("LOW_CONFIDENCE + would_have_lost → reinforce_block", () => {
    expect(
      classifyLearningAction(["LOW_CONFIDENCE"], "would_have_lost"),
    ).toBe("reinforce_block");
  });
});

describe("classifyLearningAction — RISK_MANAGER_VETO", () => {
  it("RISK_MANAGER_VETO + would_have_won → question_block", () => {
    expect(
      classifyLearningAction(["RISK_MANAGER_VETO"], "would_have_won"),
    ).toBe("question_block");
  });

  it("RISK_MANAGER_VETO + would_have_lost → reinforce_block", () => {
    expect(
      classifyLearningAction(["RISK_MANAGER_VETO"], "would_have_lost"),
    ).toBe("reinforce_block");
  });
});

// ─── Safety blocks — CRITICAL INVARIANT TESTS ────────────────────────────────

describe("classifyLearningAction — SAFETY BLOCKS (never questioned)", () => {
  const safetyBlocksWithHypotheticalWin: Array<[string, string]> = [
    ["KILL_SWITCH_ACTIVE", "would_have_won"],
    ["DAILY_LOSS_CAP_REACHED", "would_have_won"],
    ["ACCOUNT_FLOOR_BREACHED", "would_have_won"],
    ["MAX_TRADES_REACHED", "would_have_won"],
    ["COOLDOWN_ACTIVE", "would_have_won"],
    ["DOCTRINE_BLOCK", "would_have_won"],
    ["RISK_GATE_BLOCK", "would_have_won"],
  ];

  for (const [code, outcome] of safetyBlocksWithHypotheticalWin) {
    it(`${code} + ${outcome} → reinforce_block (never question_block)`, () => {
      const action = classifyLearningAction(
        [code],
        outcome as SimulationResultLabel,
      );
      expect(action).toBe("reinforce_block");
      expect(action).not.toBe("question_block");
      expect(action).not.toBe("tune_threshold");
    });
  }

  it("KILL_SWITCH_ACTIVE + would_have_won → reinforce_block (price movement is irrelevant)", () => {
    const action = classifyLearningAction(["KILL_SWITCH_ACTIVE"], "would_have_won");
    expect(action).toBe("reinforce_block");
  });

  it("DAILY_LOSS_CAP_REACHED + would_have_won → reinforce_block (hit daily loss — still correct block)", () => {
    const action = classifyLearningAction(["DAILY_LOSS_CAP_REACHED"], "would_have_won");
    expect(action).toBe("reinforce_block");
  });

  it("ACCOUNT_FLOOR_BREACHED + would_have_won → reinforce_block (balance below floor — always correct)", () => {
    const action = classifyLearningAction(["ACCOUNT_FLOOR_BREACHED"], "would_have_won");
    expect(action).toBe("reinforce_block");
  });

  it("safety block takes priority even when mixed with non-safety block", () => {
    const action = classifyLearningAction(
      ["COACH_PENALTY", "KILL_SWITCH_ACTIVE"],
      "would_have_won",
    );
    expect(action).toBe("reinforce_block");
  });

  it("safety block takes priority regardless of code order", () => {
    const action = classifyLearningAction(
      ["KILL_SWITCH_ACTIVE", "COACH_PENALTY"],
      "would_have_won",
    );
    expect(action).toBe("reinforce_block");
  });
});

// ─── hasSafetyBlock ───────────────────────────────────────────────────────────

describe("hasSafetyBlock()", () => {
  it("returns true for KILL_SWITCH_ACTIVE", () => {
    expect(hasSafetyBlock(["KILL_SWITCH_ACTIVE"])).toBe(true);
  });

  it("returns true for DAILY_LOSS_CAP_REACHED", () => {
    expect(hasSafetyBlock(["DAILY_LOSS_CAP_REACHED"])).toBe(true);
  });

  it("returns true for ACCOUNT_FLOOR_BREACHED", () => {
    expect(hasSafetyBlock(["ACCOUNT_FLOOR_BREACHED"])).toBe(true);
  });

  it("returns true for DOCTRINE_BLOCK", () => {
    expect(hasSafetyBlock(["DOCTRINE_BLOCK"])).toBe(true);
  });

  it("returns false for COACH_PENALTY", () => {
    expect(hasSafetyBlock(["COACH_PENALTY"])).toBe(false);
  });

  it("returns false for LOW_CONFIDENCE", () => {
    expect(hasSafetyBlock(["LOW_CONFIDENCE"])).toBe(false);
  });

  it("returns false for RISK_MANAGER_VETO", () => {
    expect(hasSafetyBlock(["RISK_MANAGER_VETO"])).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(hasSafetyBlock([])).toBe(false);
  });

  it("returns true if any code is a safety block", () => {
    expect(hasSafetyBlock(["COACH_PENALTY", "KILL_SWITCH_ACTIVE"])).toBe(true);
  });
});

// ─── deriveWendyGrade ─────────────────────────────────────────────────────────

describe("deriveWendyGrade()", () => {
  it("win + well-calibrated → A", () => {
    // calDelta = 0.90 - 1.0 = -0.10, |calDelta| = 0.10 ≤ 0.15 → A
    expect(deriveWendyGrade("win", 0.90)).toBe("A");
  });

  it("win + loosely calibrated → B", () => {
    // calDelta = 0.80 - 1.0 = -0.20, |calDelta| = 0.20 > 0.15 → B
    expect(deriveWendyGrade("win", 0.80)).toBe("B");
  });

  it("win + moderately calibrated → B", () => {
    // calDelta = 0.55 - 1.0 = -0.45, |calDelta| = 0.45 > 0.15 → B
    expect(deriveWendyGrade("win", 0.55)).toBe("B");
  });

  it("win + null confidence → B (not A — calibration unknown)", () => {
    expect(deriveWendyGrade("win", null)).toBe("B");
  });

  it("breakeven → C", () => {
    expect(deriveWendyGrade("breakeven", 0.70)).toBe("C");
  });

  it("breakeven + null confidence → C", () => {
    expect(deriveWendyGrade("breakeven", null)).toBe("C");
  });

  it("loss + null confidence → C (no calibration data)", () => {
    expect(deriveWendyGrade("loss", null)).toBe("C");
  });

  it("loss + well-calibrated (predicted low) → C", () => {
    // confidence = 0.3, loss → calDelta = 0.3 - 0 = 0.3 > 0.25 → D
    // Actually: 0.3 > 0.25 so D. Let me test a lower confidence.
    expect(deriveWendyGrade("loss", 0.20)).toBe("C"); // calDelta = 0.2 ≤ 0.25
  });

  it("loss + moderate overconfidence → D", () => {
    expect(deriveWendyGrade("loss", 0.45)).toBe("D"); // calDelta = 0.45, 0.25 < 0.45 ≤ 0.50
  });

  it("loss + heavy overconfidence → F", () => {
    expect(deriveWendyGrade("loss", 0.90)).toBe("F"); // calDelta = 0.9 > 0.5
  });

  it("loss + confidence 0.60 → F (above D/F boundary of 0.5)", () => {
    expect(deriveWendyGrade("loss", 0.60)).toBe("F"); // calDelta = 0.60 > 0.5
  });

  it("loss + calDelta exactly 0.25 boundary → C", () => {
    expect(deriveWendyGrade("loss", 0.25)).toBe("C"); // calDelta = 0.25 ≤ 0.25
  });

  it("loss + calDelta just above 0.25 → D", () => {
    expect(deriveWendyGrade("loss", 0.30)).toBe("D"); // calDelta = 0.30, 0.25 < 0.30 ≤ 0.50
  });

  it("loss + calDelta exactly 0.5 boundary → D", () => {
    expect(deriveWendyGrade("loss", 0.50)).toBe("D"); // calDelta = 0.5 ≤ 0.5
  });

  it("loss + calDelta just above 0.5 → F", () => {
    expect(deriveWendyGrade("loss", 0.51)).toBe("F"); // calDelta = 0.51 > 0.5
  });
});

// ─── buildReplayPacketOutcomePatch ────────────────────────────────────────────

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

describe("buildReplayPacketOutcomePatch — security", () => {
  it("patch contains no sensitive credentials", () => {
    const patch = buildReplayPacketOutcomePatch({
      outcome: "win",
      confidence: 0.75,
      pnl: 12.5,
      pnlPct: 1.5,
      openedAt: "2026-05-10T10:00:00.000Z",
      closedAt: "2026-05-10T12:00:00.000Z",
      notes: "TP1 hit cleanly",
    });
    const serialized = JSON.stringify(patch);
    for (const pattern of SENSITIVE_PATTERNS) {
      expect(serialized).not.toContain(pattern);
    }
  });

  it("patch contains only the expected safe outcome fields", () => {
    const patch = buildReplayPacketOutcomePatch({
      outcome: "loss",
      confidence: 0.80,
      pnl: -5.0,
      pnlPct: -0.6,
      openedAt: "2026-05-10T10:00:00.000Z",
      closedAt: "2026-05-10T11:00:00.000Z",
      notes: "Stopped out",
    });
    const allowedKeys = new Set([
      "actualOutcome",
      "wendyGrade",
      "outcomeRecordedAt",
      "realizedPnl",
      "realizedPnlPct",
      "exitReason",
      "holdDurationHours",
    ]);
    for (const key of Object.keys(patch)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  it("does not include trade ID, user ID, or broker fields", () => {
    const patch = buildReplayPacketOutcomePatch({
      outcome: "win",
      confidence: 0.70,
      pnl: 8.0,
      pnlPct: 0.9,
      openedAt: "2026-05-10T10:00:00.000Z",
      closedAt: "2026-05-10T11:30:00.000Z",
      notes: null,
    });
    expect("tradeId" in patch).toBe(false);
    expect("userId" in patch).toBe(false);
    expect("brokerId" in patch).toBe(false);
    expect("signalId" in patch).toBe(false);
    expect("apiKey" in patch).toBe(false);
  });
});

describe("buildReplayPacketOutcomePatch — correctness", () => {
  it("win trade produces actualOutcome = win", () => {
    const patch = buildReplayPacketOutcomePatch({
      outcome: "win",
      confidence: 0.70,
      pnl: 10,
      pnlPct: 1.0,
      openedAt: "2026-05-10T10:00:00.000Z",
      closedAt: "2026-05-10T12:00:00.000Z",
      notes: null,
    });
    expect(patch.actualOutcome).toBe("win");
  });

  it("loss trade produces actualOutcome = loss", () => {
    const patch = buildReplayPacketOutcomePatch({
      outcome: "loss",
      confidence: 0.80,
      pnl: -5,
      pnlPct: -0.5,
      openedAt: "2026-05-10T10:00:00.000Z",
      closedAt: "2026-05-10T10:30:00.000Z",
      notes: "Stop hit",
    });
    expect(patch.actualOutcome).toBe("loss");
  });

  it("computes holdDurationHours correctly", () => {
    const patch = buildReplayPacketOutcomePatch({
      outcome: "win",
      confidence: 0.65,
      pnl: 5,
      pnlPct: 0.5,
      openedAt: "2026-05-10T10:00:00.000Z",
      closedAt: "2026-05-10T12:00:00.000Z", // 2 hours
      notes: null,
    });
    expect(patch.holdDurationHours).toBeCloseTo(2, 1);
  });

  it("holdDurationHours is null when openedAt is null", () => {
    const patch = buildReplayPacketOutcomePatch({
      outcome: "win",
      confidence: 0.65,
      pnl: 5,
      pnlPct: 0.5,
      openedAt: null,
      closedAt: "2026-05-10T12:00:00.000Z",
      notes: null,
    });
    expect(patch.holdDurationHours).toBeNull();
  });

  it("exitReason matches notes", () => {
    const patch = buildReplayPacketOutcomePatch({
      outcome: "loss",
      confidence: 0.75,
      pnl: -8,
      pnlPct: -0.8,
      openedAt: "2026-05-10T10:00:00.000Z",
      closedAt: "2026-05-10T10:15:00.000Z",
      notes: "Stop triggered at 94500",
    });
    expect(patch.exitReason).toBe("Stop triggered at 94500");
  });

  it("outcomeRecordedAt is a valid ISO timestamp", () => {
    const patch = buildReplayPacketOutcomePatch({
      outcome: "win",
      confidence: 0.70,
      pnl: 5,
      pnlPct: 0.5,
      openedAt: "2026-05-10T10:00:00.000Z",
      closedAt: "2026-05-10T11:00:00.000Z",
      notes: null,
    });
    expect(() => new Date(patch.outcomeRecordedAt)).not.toThrow();
    expect(new Date(patch.outcomeRecordedAt).getFullYear()).toBeGreaterThanOrEqual(2026);
  });
});

// ─── enrichDecisionMemorySimulation — pure logic ──────────────────────────────

describe("enrichDecisionMemorySimulation — missing data guards", () => {
  it("null symbol → insufficient_data (account-level halt)", async () => {
    const result = await enrichDecisionMemorySimulation({
      symbol: null,
      blockerCodes: ["KILL_SWITCH_ACTIVE"],
      decisionRanAt: "2026-05-10T10:00:00.000Z",
      lookaheadWindow: "1h",
      side: "long",
    });
    expect(result.result_label).toBe("insufficient_data");
    expect(result.insufficient_data_reason).toContain("no symbol");
    expect(result.recommended_learning_action).toBe("ignore_insufficient_data");
  });

  it("null decisionRanAt → insufficient_data", async () => {
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: null,
      lookaheadWindow: "1h",
      side: "long",
    });
    expect(result.result_label).toBe("insufficient_data");
    expect(result.insufficient_data_reason).toContain("no ranAt");
  });

  it("invalid decisionRanAt → insufficient_data", async () => {
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: "not-a-date",
      lookaheadWindow: "1h",
      side: "long",
    });
    expect(result.result_label).toBe("insufficient_data");
    expect(result.insufficient_data_reason).toContain("invalid ranAt");
  });

  it("decision too recent → insufficient_data (data not yet available)", async () => {
    // Timestamp = right now → too recent for 1h lookahead
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: new Date().toISOString(),
      lookaheadWindow: "1h",
      side: "long",
    });
    expect(result.result_label).toBe("insufficient_data");
    expect(result.insufficient_data_reason).toContain("too recent");
  });
});

describe("enrichDecisionMemorySimulation — Coinbase fetch (mocked)", () => {
  const OLD_FETCH = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = OLD_FETCH;
  });

  it("Coinbase returning candles → computes hypothetical return", async () => {
    const mockCandles: number[][] = [
      // [time, low, high, open, close, volume] newest-first (Coinbase format)
      [1746014400, 100_500, 101_800, 101_000, 101_500, 5.2], // newer
      [1746010800, 100_000, 101_000, 100_000, 101_000, 4.8], // older
    ];

    mockFetch(mockCandles);

    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });

    expect(result.result_label).not.toBe("insufficient_data");
    expect(result.simulated_entry_price).toBeGreaterThan(0);
    expect(result.simulated_exit_price).toBeGreaterThan(0);
    expect(result.hypothetical_return_pct).not.toBeNull();
    expect(result.enriched_at).toBeTruthy();
    // No credentials in result
    const serialized = JSON.stringify(result);
    for (const pattern of SENSITIVE_PATTERNS) {
      expect(serialized).not.toContain(pattern);
    }
  });

  it("Coinbase returning empty array → insufficient_data", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    } as unknown as Response);

    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });

    expect(result.result_label).toBe("insufficient_data");
    expect(result.recommended_learning_action).toBe("ignore_insufficient_data");
  });

  it("Coinbase returning HTTP error → insufficient_data", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    } as unknown as Response);

    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });

    expect(result.result_label).toBe("insufficient_data");
    expect(result.recommended_learning_action).toBe("ignore_insufficient_data");
  });

  it("network error → insufficient_data (no throw)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network down"));

    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });

    expect(result.result_label).toBe("insufficient_data");
    expect(result.recommended_learning_action).toBe("ignore_insufficient_data");
  });

  it("profitable candles + COACH_PENALTY → would_have_won → question_block", async () => {
    // Entry: 100_000, exit: 102_000 → +2% (above 0.3% edge threshold)
    const mockCandles: number[][] = [
      [1746014400, 101_500, 102_500, 102_000, 102_000, 3.0],
      [1746010800, 99_800, 101_000, 100_000, 101_500, 4.0],
    ];
    mockFetch(mockCandles);

    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });

    expect(result.result_label).toBe("would_have_won");
    expect(result.recommended_learning_action).toBe("question_block");
  });

  it("losing candles + COACH_PENALTY → would_have_lost → reinforce_block", async () => {
    // Entry: 100_000, exit: 97_000 → -3% (below -0.3% edge threshold)
    const mockCandles: number[][] = [
      [1746014400, 96_500, 100_200, 97_500, 97_000, 6.0],
      [1746010800, 99_000, 100_500, 100_000, 97_500, 5.0],
    ];
    mockFetch(mockCandles);

    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });

    expect(result.result_label).toBe("would_have_lost");
    expect(result.recommended_learning_action).toBe("reinforce_block");
  });

  it("profitable candles + LOW_CONFIDENCE → would_have_won → tune_threshold", async () => {
    const mockCandles: number[][] = [
      [1746014400, 101_000, 103_000, 103_000, 103_000, 3.5],
      [1746010800, 99_500, 101_500, 100_000, 101_000, 4.5],
    ];
    mockFetch(mockCandles);

    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["LOW_CONFIDENCE"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });

    expect(result.result_label).toBe("would_have_won");
    expect(result.recommended_learning_action).toBe("tune_threshold");
  });

  it("KILL_SWITCH_ACTIVE + profitable candles → reinforce_block (safety invariant)", async () => {
    // Even if market went up, kill-switch block must never be questioned
    const mockCandles: number[][] = [
      [1746014400, 101_000, 105_000, 105_000, 105_000, 8.0],
      [1746010800, 100_000, 102_000, 100_000, 101_000, 5.0],
    ];
    mockFetch(mockCandles);

    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["KILL_SWITCH_ACTIVE"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });

    expect(result.result_label).toBe("would_have_won");
    expect(result.recommended_learning_action).toBe("reinforce_block");
    expect(result.recommended_learning_action).not.toBe("question_block");
    expect(result.recommended_learning_action).not.toBe("tune_threshold");
  });

  it("DAILY_LOSS_CAP_REACHED + profitable candles → reinforce_block (safety invariant)", async () => {
    const mockCandles: number[][] = [
      [1746014400, 101_000, 104_000, 104_000, 104_000, 6.0],
      [1746010800, 100_000, 101_500, 100_000, 101_000, 4.0],
    ];
    mockFetch(mockCandles);

    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["DAILY_LOSS_CAP_REACHED"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });

    expect(result.recommended_learning_action).toBe("reinforce_block");
  });

  it("enrichment does not create trades (no execution fields in result)", async () => {
    mockFetch([[1746010800, 100_000, 101_000, 100_000, 101_000, 4.0]]);

    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });

    // Structural proof: result has no execution fields
    expect("tradeId" in result).toBe(false);
    expect("orderId" in result).toBe(false);
    expect("executedAt" in result).toBe(false);
    expect("approvedSignal" in result).toBe(false);
    expect("liveMode" in result).toBe(false);
    expect("brokerCredentials" in result).toBe(false);
  });

  it("enrichment does not approve signals (no approval fields in result)", async () => {
    mockFetch([[1746010800, 100_000, 102_000, 100_000, 102_000, 4.0]]);

    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["LOW_CONFIDENCE"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });

    expect(result.recommended_learning_action).toBe("tune_threshold");
    // No approval, execution, or live-trading fields
    expect("signalApproved" in result).toBe(false);
    expect("orderPlaced" in result).toBe(false);
    expect("enableLiveTrading" in result).toBe(false);
    expect("riskGateOverride" in result).toBe(false);
  });

  it("enrichment does not alter doctrine (no doctrine fields in result)", async () => {
    mockFetch([[1746010800, 100_000, 100_500, 100_000, 100_500, 3.0]]);

    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });

    expect("doctrinePatch" in result).toBe(false);
    expect("maxOrderPct" in result).toBe(false);
    expect("killSwitchFloor" in result).toBe(false);
    expect("dailyLossCap" in result).toBe(false);
    expect("updatedDoctrine" in result).toBe(false);
  });

  it("MAE and MFE are computed when candles are available (long)", async () => {
    // Entry: open of first candle = 100_000
    // min low across candles: 99_500 → MAE = (99500 - 100000) / 100000 = -0.005
    // max high across candles: 102_500 → MFE = (102500 - 100000) / 100000 = 0.025
    const mockCandles: number[][] = [
      [1746014400, 100_800, 102_500, 102_000, 102_000, 3.0],
      [1746010800, 99_500, 101_000, 100_000, 100_800, 4.0],
    ];
    mockFetch(mockCandles);

    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });

    if (result.result_label !== "insufficient_data") {
      expect(result.max_adverse_excursion).toBeLessThan(0);
      expect(result.max_favorable_excursion).toBeGreaterThan(0);
    }
  });
});

// ─── Direction-aware tests (PR #38 hardening) ────────────────────────────────

describe("direction-aware enrichment — long signal", () => {
  const OLD_FETCH = globalThis.fetch;
  afterEach(() => { globalThis.fetch = OLD_FETCH; });

  it("long + price up → would_have_won", async () => {
    // Entry 100_000, exit 103_000 → +3% for long
    mockFetch([
      [1746014400, 102_000, 104_000, 103_500, 103_000, 2.0],
      [1746010800, 99_500, 101_000, 100_000, 102_000, 3.0],
    ]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });
    expect(result.result_label).toBe("would_have_won");
    expect(result.hypothetical_return_pct).toBeGreaterThan(0);
    expect(result.simulated_side).toBe("long");
  });

  it("long + price down → would_have_lost", async () => {
    // Entry 100_000, exit 96_000 → -4% for long
    mockFetch([
      [1746014400, 95_500, 100_200, 97_500, 96_000, 5.0],
      [1746010800, 98_000, 100_500, 100_000, 97_500, 4.0],
    ]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });
    expect(result.result_label).toBe("would_have_lost");
    expect(result.hypothetical_return_pct).toBeLessThan(0);
    expect(result.simulated_side).toBe("long");
  });

  it("long MFE: max high above entry → MFE ≥ 0", async () => {
    // Entry 100_000; maxHigh = 104_000 → MFE = 0.04
    mockFetch([
      [1746014400, 101_000, 104_000, 103_000, 103_000, 2.0],
      [1746010800, 99_000, 101_500, 100_000, 101_000, 3.0],
    ]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });
    expect(result.max_favorable_excursion).not.toBeNull();
    expect(result.max_favorable_excursion!).toBeGreaterThanOrEqual(0);
    // maxHigh=104_000, entry=100_000 → (104000-100000)/100000 = 0.04
    expect(result.max_favorable_excursion!).toBeCloseTo(0.04, 5);
  });

  it("long MAE: min low below entry → MAE ≤ 0", async () => {
    // Entry 100_000; minLow = 98_000 → MAE = -0.02
    mockFetch([
      [1746014400, 99_000, 103_000, 102_000, 102_000, 2.0],
      [1746010800, 98_000, 100_500, 100_000, 99_000, 4.0],
    ]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });
    expect(result.max_adverse_excursion).not.toBeNull();
    expect(result.max_adverse_excursion!).toBeLessThanOrEqual(0);
    // minLow=98_000, entry=100_000 → (98000-100000)/100000 = -0.02
    expect(result.max_adverse_excursion!).toBeCloseTo(-0.02, 5);
  });
});

describe("direction-aware enrichment — short signal", () => {
  const OLD_FETCH = globalThis.fetch;
  afterEach(() => { globalThis.fetch = OLD_FETCH; });

  it("short + price down → would_have_won", async () => {
    // Entry 100_000, exit 96_000 → (100000-96000)/100000 = +4% for short
    mockFetch([
      [1746014400, 95_500, 100_200, 97_500, 96_000, 5.0],
      [1746010800, 98_000, 100_500, 100_000, 97_500, 4.0],
    ]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "short",
    });
    expect(result.result_label).toBe("would_have_won");
    expect(result.hypothetical_return_pct).toBeGreaterThan(0);
    expect(result.simulated_side).toBe("short");
  });

  it("short + price up → would_have_lost", async () => {
    // Entry 100_000, exit 103_000 → (100000-103000)/100000 = -3% for short
    mockFetch([
      [1746014400, 102_000, 104_000, 103_500, 103_000, 2.0],
      [1746010800, 99_500, 101_000, 100_000, 102_000, 3.0],
    ]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "short",
    });
    expect(result.result_label).toBe("would_have_lost");
    expect(result.hypothetical_return_pct).toBeLessThan(0);
    expect(result.simulated_side).toBe("short");
  });

  it("short MFE: price fell below entry → MFE ≥ 0", async () => {
    // Entry 100_000; minLow = 96_000 → MFE = (100000-96000)/100000 = 0.04
    mockFetch([
      [1746014400, 96_000, 100_200, 97_500, 96_500, 5.0],
      [1746010800, 97_000, 100_500, 100_000, 97_000, 4.0],
    ]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "short",
    });
    expect(result.max_favorable_excursion).not.toBeNull();
    expect(result.max_favorable_excursion!).toBeGreaterThanOrEqual(0);
    // minLow=96_000, entry=100_000 → (100000-96000)/100000 = 0.04
    expect(result.max_favorable_excursion!).toBeCloseTo(0.04, 5);
  });

  it("short MAE: price rose above entry → MAE ≤ 0", async () => {
    // Entry 100_000; maxHigh = 104_000 → MAE = (100000-104000)/100000 = -0.04
    mockFetch([
      [1746014400, 101_000, 104_000, 103_000, 102_000, 2.0],
      [1746010800, 99_500, 101_500, 100_000, 101_000, 3.0],
    ]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "short",
    });
    expect(result.max_adverse_excursion).not.toBeNull();
    expect(result.max_adverse_excursion!).toBeLessThanOrEqual(0);
    // maxHigh=104_000, entry=100_000 → (100000-104000)/100000 = -0.04
    expect(result.max_adverse_excursion!).toBeCloseTo(-0.04, 5);
  });

  it("same candles score opposite for long vs short", async () => {
    // Price rose from 100_000 to 103_000 — long wins, short loses
    const risingCandles: number[][] = [
      [1746014400, 101_500, 104_000, 103_000, 103_000, 2.0],
      [1746010800, 99_500, 101_000, 100_000, 102_000, 3.0],
    ];

    mockFetch(risingCandles);
    const longResult = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });

    mockFetch(risingCandles);
    const shortResult = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "short",
    });

    expect(longResult.result_label).toBe("would_have_won");
    expect(shortResult.result_label).toBe("would_have_lost");
  });

  it("safety block + profitable short → reinforce_block (safety invariant holds for shorts)", async () => {
    // Price fell — short would have won, but safety block must still reinforce
    mockFetch([
      [1746014400, 94_000, 100_200, 97_000, 94_000, 6.0],
      [1746010800, 97_000, 100_500, 100_000, 97_000, 4.0],
    ]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["KILL_SWITCH_ACTIVE"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "short",
    });
    // Short would have won (price fell)
    expect(result.result_label).toBe("would_have_won");
    // But safety block is always reinforced
    expect(result.recommended_learning_action).toBe("reinforce_block");
    expect(result.recommended_learning_action).not.toBe("question_block");
  });

  it("DOCTRINE_BLOCK + profitable short → reinforce_block", async () => {
    mockFetch([
      [1746014400, 93_000, 100_100, 96_000, 93_000, 7.0],
      [1746010800, 97_000, 100_400, 100_000, 97_000, 5.0],
    ]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["DOCTRINE_BLOCK"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "short",
    });
    expect(result.result_label).toBe("would_have_won");
    expect(result.recommended_learning_action).toBe("reinforce_block");
  });
});

describe("direction-aware enrichment — missing side", () => {
  const OLD_FETCH = globalThis.fetch;
  afterEach(() => { globalThis.fetch = OLD_FETCH; });

  it("missing side → insufficient_data, not question_block", async () => {
    // Profitable candles — but without side we cannot score direction
    mockFetch([
      [1746014400, 101_500, 104_000, 103_000, 103_000, 2.0],
      [1746010800, 99_500, 101_000, 100_000, 102_000, 3.0],
    ]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: null,
    });
    expect(result.result_label).toBe("insufficient_data");
    expect(result.recommended_learning_action).toBe("ignore_insufficient_data");
    expect(result.recommended_learning_action).not.toBe("question_block");
    expect(result.recommended_learning_action).not.toBe("tune_threshold");
  });

  it("missing side → insufficient_data_reason contains 'missing_side'", async () => {
    mockFetch([
      [1746014400, 101_000, 103_000, 102_000, 102_000, 2.0],
      [1746010800, 99_000, 101_000, 100_000, 101_000, 3.0],
    ]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: null,
    });
    expect(result.insufficient_data_reason).toContain("missing_side");
  });

  it("missing side but candles available → entry/exit prices recorded", async () => {
    // Even without side we record the raw prices for traceability
    mockFetch([
      [1746014400, 101_000, 103_000, 102_000, 102_000, 2.0],
      [1746010800, 99_000, 101_000, 100_000, 101_000, 3.0],
    ]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: null,
    });
    // Prices are available (from candles) even though direction is unknown
    expect(result.simulated_entry_price).toBeGreaterThan(0);
    expect(result.simulated_exit_price).toBeGreaterThan(0);
    // But direction-dependent metrics are null
    expect(result.hypothetical_return_pct).toBeNull();
    expect(result.max_adverse_excursion).toBeNull();
    expect(result.max_favorable_excursion).toBeNull();
    expect(result.simulated_side).toBeNull();
  });

  it("missing side → LOW_CONFIDENCE does not produce tune_threshold", async () => {
    // Even with LOW_CONFIDENCE blocker, missing side must not produce tune_threshold
    mockFetch([
      [1746014400, 101_000, 105_000, 104_000, 104_000, 3.0],
      [1746010800, 99_000, 101_500, 100_000, 101_000, 4.0],
    ]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["LOW_CONFIDENCE"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: null,
    });
    expect(result.recommended_learning_action).not.toBe("tune_threshold");
    expect(result.recommended_learning_action).toBe("ignore_insufficient_data");
  });

  it("missing side + no candles → prices also null (double insufficient_data)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    } as unknown as Response);

    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: null,
    });
    expect(result.result_label).toBe("insufficient_data");
    expect(result.simulated_entry_price).toBeNull();
    expect(result.simulated_exit_price).toBeNull();
  });
});

describe("simulated_side field", () => {
  const OLD_FETCH = globalThis.fetch;
  afterEach(() => { globalThis.fetch = OLD_FETCH; });

  it("long enrichment sets simulated_side = 'long'", async () => {
    mockFetch([[1746010800, 100_000, 102_000, 100_000, 102_000, 3.0]]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });
    expect(result.simulated_side).toBe("long");
  });

  it("short enrichment sets simulated_side = 'short'", async () => {
    mockFetch([[1746010800, 97_000, 100_500, 100_000, 97_000, 3.0]]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "short",
    });
    expect(result.simulated_side).toBe("short");
  });

  it("missing side sets simulated_side = null", async () => {
    mockFetch([[1746010800, 100_000, 102_000, 100_000, 102_000, 3.0]]);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: null,
    });
    expect(result.simulated_side).toBeNull();
  });

  it("insufficient_data (no candles) sets simulated_side = null", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 } as unknown as Response);
    const result = await enrichDecisionMemorySimulation({
      symbol: "BTC-USD",
      blockerCodes: ["COACH_PENALTY"],
      decisionRanAt: oldDecisionTime(),
      lookaheadWindow: "1h",
      side: "long",
    });
    expect(result.result_label).toBe("insufficient_data");
    expect(result.simulated_side).toBeNull();
  });
});

// ─── MIN_ENRICHMENT_AGE_SECONDS ───────────────────────────────────────────────

describe("MIN_ENRICHMENT_AGE_SECONDS", () => {
  it("15m window requires at least 900s age", () => {
    expect(MIN_ENRICHMENT_AGE_SECONDS["15m"]).toBe(900);
  });

  it("1h window requires at least 3600s age", () => {
    expect(MIN_ENRICHMENT_AGE_SECONDS["1h"]).toBe(3600);
  });

  it("4h window requires at least 14400s age", () => {
    expect(MIN_ENRICHMENT_AGE_SECONDS["4h"]).toBe(14400);
  });
});

// ─── Browser-side display helpers ─────────────────────────────────────────────

describe("simulationSummary()", () => {
  it("insufficient_data shows reason", () => {
    const result = makeSimulationResult({
      result_label: "insufficient_data",
      insufficient_data_reason: "no candles available",
      recommended_learning_action: "ignore_insufficient_data",
    });
    const summary = simulationSummary(result);
    expect(summary).toContain("no candles available");
  });

  it("no_clear_edge shows percentage and window", () => {
    const result = makeSimulationResult({
      result_label: "no_clear_edge",
      hypothetical_return_pct: 0.001,
      recommended_learning_action: "ignore_insufficient_data",
    });
    const summary = simulationSummary(result);
    expect(summary).toContain("1h");
    expect(summary).toContain("No clear edge");
  });

  it("would_have_won shows up arrow and action", () => {
    const result = makeSimulationResult({
      result_label: "would_have_won",
      hypothetical_return_pct: 0.02,
      recommended_learning_action: "question_block",
    });
    const summary = simulationSummary(result);
    expect(summary).toContain("▲");
    expect(summary).toContain("Question this block");
  });

  it("would_have_lost shows down arrow", () => {
    const result = makeSimulationResult({
      result_label: "would_have_lost",
      hypothetical_return_pct: -0.015,
      recommended_learning_action: "reinforce_block",
    });
    const summary = simulationSummary(result);
    expect(summary).toContain("▼");
    expect(summary).toContain("Reinforce block");
  });
});

describe("isActionable()", () => {
  it("would_have_won is actionable", () => {
    expect(isActionable(makeSimulationResult({ result_label: "would_have_won" }))).toBe(true);
  });

  it("would_have_lost is actionable", () => {
    expect(isActionable(makeSimulationResult({ result_label: "would_have_lost" }))).toBe(true);
  });

  it("insufficient_data is not actionable", () => {
    expect(isActionable(makeSimulationResult({ result_label: "insufficient_data" }))).toBe(false);
  });

  it("no_clear_edge is not actionable", () => {
    expect(isActionable(makeSimulationResult({ result_label: "no_clear_edge" }))).toBe(false);
  });
});

describe("suggestsReview()", () => {
  it("question_block suggests review", () => {
    expect(
      suggestsReview(makeSimulationResult({ recommended_learning_action: "question_block" })),
    ).toBe(true);
  });

  it("tune_threshold suggests review", () => {
    expect(
      suggestsReview(makeSimulationResult({ recommended_learning_action: "tune_threshold" })),
    ).toBe(true);
  });

  it("reinforce_block does not suggest review", () => {
    expect(
      suggestsReview(makeSimulationResult({ recommended_learning_action: "reinforce_block" })),
    ).toBe(false);
  });

  it("ignore_insufficient_data does not suggest review", () => {
    expect(
      suggestsReview(
        makeSimulationResult({ recommended_learning_action: "ignore_insufficient_data" }),
      ),
    ).toBe(false);
  });
});

describe("RESULT_LABEL_DISPLAY", () => {
  it("has display label for every result label", () => {
    const labels: SimulationResultLabel[] = [
      "would_have_won",
      "would_have_lost",
      "no_clear_edge",
      "insufficient_data",
    ];
    for (const label of labels) {
      expect(RESULT_LABEL_DISPLAY[label]).toBeTruthy();
      expect(typeof RESULT_LABEL_DISPLAY[label]).toBe("string");
    }
  });
});

describe("LEARNING_ACTION_DISPLAY", () => {
  it("has display label for every learning action", () => {
    const actions: LearningAction[] = [
      "reinforce_block",
      "question_block",
      "tune_threshold",
      "ignore_insufficient_data",
    ];
    for (const action of actions) {
      expect(LEARNING_ACTION_DISPLAY[action]).toBeTruthy();
      expect(typeof LEARNING_ACTION_DISPLAY[action]).toBe("string");
    }
  });
});
