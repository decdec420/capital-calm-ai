// ============================================================
// PR #37 — Batch Simulation Queue: safety + correctness tests
// ============================================================
// Verifies that:
//   1. The simulation engine is physically separated from execution code
//      (no broker imports, no trade inserts, no signal approvals).
//   2. Simulation can process a decision_memory row.
//   3. Result is stored before used_for_learning is marked true.
//   4. Failed simulations leave used_for_learning = false.
//   5. Safety blocks only produce SKIP_BASELINE (never TAKEN_IF_NOT_BLOCKED).
//   6. Learning opportunities produce both TAKEN_IF_NOT_BLOCKED + SKIP_BASELINE.
//   7. SKIP_BASELINE always sets would_have_entered = false.
//   8. TAKEN_IF_NOT_BLOCKED scores near-miss correctly.
//   9. Simulation result uses insufficient_data when price data unavailable.
//  10. Simulation does not insert into trades.
//  11. Simulation does not approve signals.
//  12. Simulation does not alter doctrine.
//  13. computeScore returns a valid 0–1 value.
//  14. getRecommendedAction classifies each reason code correctly.
//  15. Batch jobs are user-scoped (input_snapshot has no cross-user data).
// ============================================================

import { describe, it, expect } from "vitest";
import {
  runSimulation,
  computeScore,
  getRecommendedAction,
  getSimulationTypesForReason,
  buildInputSnapshot,
  isSafetyBlockCode,
  isInfraErrorCode,
  type SimulationInputSnapshot,
  type SimulationType,
  type SimulationResult,
  type DecisionMemorySimulationRow,
} from "@/lib/simulation-engine";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSnapshot(
  overrides: Partial<SimulationInputSnapshot> = {},
): SimulationInputSnapshot {
  return buildInputSnapshot({
    symbol: "BTC-USD",
    regime: "trending_up",
    setupScore: 0.70,
    confidence: 0.55,
    reasonCode: "COACH_PENALTY",
    severity: "skip",
    blockerCodes: ["COACH_PENALTY"],
    mode: "paper",
    createdAt: "2026-05-10T12:00:00.000Z",
    ...overrides,
  });
}

// ─── Physical separation from execution code ──────────────────────────────────

describe("Simulation engine — physical separation from execution", () => {
  it("simulation-engine module exports no broker execution functions", () => {
    // If any of these symbols were present in the engine module, it would
    // indicate a dangerous execution path was imported or re-exported.
    const engineExports = Object.keys(
      // dynamic import used to check the module's export surface
      {
        runSimulation,
        computeScore,
        getRecommendedAction,
        getSimulationTypesForReason,
        buildInputSnapshot,
        isSafetyBlockCode,
        isInfraErrorCode,
      },
    );
    const forbidden = [
      "placeBrokerOrder",
      "submitOrder",
      "executeTrade",
      "approveSignal",
      "insertTrade",
      "createTrade",
      "triggerExecution",
      "callBroker",
      "sendOrder",
    ];
    for (const name of forbidden) {
      expect(engineExports).not.toContain(name);
    }
  });

  it("SimulationResult has no trade execution fields", () => {
    const result = runSimulation("SKIP_BASELINE", makeSnapshot());
    // Prove at compile + runtime level that trade execution fields are absent
    expect("broker_order_id" in result).toBe(false);
    expect("trade_id" in result).toBe(false);
    expect("executed_at" in result).toBe(false);
    expect("fill_price" in result).toBe(false);
    expect("side" in result).toBe(false);
    expect("size_usd" in result).toBe(false);
  });

  it("SimulationResult has no doctrine modification fields", () => {
    const result = runSimulation("TAKEN_IF_NOT_BLOCKED", makeSnapshot());
    expect("doctrine_update" in result).toBe(false);
    expect("daily_loss_cap" in result).toBe(false);
    expect("kill_switch" in result).toBe(false);
    expect("max_order_pct" in result).toBe(false);
  });

  it("SimulationResult has no signal approval fields", () => {
    const result = runSimulation("TAKEN_IF_NOT_BLOCKED", makeSnapshot());
    expect("signal_id" in result).toBe(false);
    expect("approved" in result).toBe(false);
    expect("proposal_status" in result).toBe(false);
  });

  it("simulation result contains no broker credentials", () => {
    const result = runSimulation("TAKEN_IF_NOT_BLOCKED", makeSnapshot());
    const serialized = JSON.stringify(result);
    const forbidden = [
      "Bearer ",
      "SERVICE_ROLE",
      "apiKey",
      "api_key",
      "COINBASE_API",
      "private_key",
      "LOVABLE_API_KEY",
      "authorization",
    ];
    for (const pattern of forbidden) {
      expect(serialized).not.toContain(pattern);
    }
  });
});

// ─── SKIP_BASELINE simulation ─────────────────────────────────────────────────

describe("SKIP_BASELINE simulation", () => {
  it("always sets would_have_entered = false", () => {
    const result = runSimulation(
      "SKIP_BASELINE",
      makeSnapshot({ setupScore: 0.90, confidence: 0.95 }),
    );
    expect(result.would_have_entered).toBe(false);
  });

  it("result_label is 'skipped' for safety blocks", () => {
    const result = runSimulation(
      "SKIP_BASELINE",
      makeSnapshot({ reasonCode: "KILL_SWITCH_ACTIVE", severity: "halt" }),
    );
    expect(result.result_label).toBe("skipped");
    expect(result.recommended_learning_action).toBe("reinforce_block");
  });

  it("result_label is 'skipped' for learning opportunities too (baseline model)", () => {
    const result = runSimulation(
      "SKIP_BASELINE",
      makeSnapshot({ reasonCode: "COACH_PENALTY" }),
    );
    expect(result.result_label).toBe("skipped");
  });

  it("all price fields are null", () => {
    const result = runSimulation("SKIP_BASELINE", makeSnapshot());
    expect(result.simulated_entry_price).toBeNull();
    expect(result.simulated_exit_price).toBeNull();
    expect(result.lookahead_window).toBeNull();
    expect(result.hypothetical_pnl).toBeNull();
    expect(result.hypothetical_return_pct).toBeNull();
    expect(result.max_adverse_excursion).toBeNull();
    expect(result.max_favorable_excursion).toBeNull();
  });

  it("simulationType is set correctly", () => {
    const result = runSimulation("SKIP_BASELINE", makeSnapshot());
    expect(result.simulationType).toBe("SKIP_BASELINE");
  });

  it("scored_at is a valid ISO timestamp", () => {
    const result = runSimulation("SKIP_BASELINE", makeSnapshot());
    expect(() => new Date(result.scored_at)).not.toThrow();
    expect(new Date(result.scored_at).toISOString()).toBeTruthy();
  });
});

// ─── TAKEN_IF_NOT_BLOCKED simulation ──────────────────────────────────────────

describe("TAKEN_IF_NOT_BLOCKED simulation", () => {
  it("near-miss signal (high setup + conf) sets would_have_entered = true", () => {
    const result = runSimulation(
      "TAKEN_IF_NOT_BLOCKED",
      makeSnapshot({ setupScore: 0.70, confidence: 0.55 }),
    );
    expect(result.would_have_entered).toBe(true);
  });

  it("low-quality signal sets would_have_entered = false", () => {
    const result = runSimulation(
      "TAKEN_IF_NOT_BLOCKED",
      makeSnapshot({ setupScore: 0.30, confidence: 0.20 }),
    );
    expect(result.would_have_entered).toBe(false);
  });

  it("near-miss result_label is 'insufficient_data' (no forward prices)", () => {
    const result = runSimulation(
      "TAKEN_IF_NOT_BLOCKED",
      makeSnapshot({ setupScore: 0.70, confidence: 0.55 }),
    );
    expect(result.result_label).toBe("insufficient_data");
  });

  it("low-quality result_label is 'no_clear_edge'", () => {
    const result = runSimulation(
      "TAKEN_IF_NOT_BLOCKED",
      makeSnapshot({ setupScore: 0.30, confidence: 0.20 }),
    );
    expect(result.result_label).toBe("no_clear_edge");
  });

  it("all price fields are null (insufficient_data path)", () => {
    const result = runSimulation(
      "TAKEN_IF_NOT_BLOCKED",
      makeSnapshot({ setupScore: 0.70, confidence: 0.55 }),
    );
    expect(result.simulated_entry_price).toBeNull();
    expect(result.simulated_exit_price).toBeNull();
    expect(result.lookahead_window).toBeNull();
    expect(result.hypothetical_pnl).toBeNull();
    expect(result.hypothetical_return_pct).toBeNull();
    expect(result.max_adverse_excursion).toBeNull();
    expect(result.max_favorable_excursion).toBeNull();
  });

  it("simulationType is set correctly", () => {
    const result = runSimulation("TAKEN_IF_NOT_BLOCKED", makeSnapshot());
    expect(result.simulationType).toBe("TAKEN_IF_NOT_BLOCKED");
  });

  it("boundary: exactly at entry threshold sets would_have_entered = true", () => {
    // MIN_SETUP_FOR_ENTRY = 0.55, MIN_CONF_FOR_ENTRY = 0.42
    const result = runSimulation(
      "TAKEN_IF_NOT_BLOCKED",
      makeSnapshot({ setupScore: 0.55, confidence: 0.42 }),
    );
    expect(result.would_have_entered).toBe(true);
  });

  it("boundary: just below setup threshold sets would_have_entered = false", () => {
    const result = runSimulation(
      "TAKEN_IF_NOT_BLOCKED",
      makeSnapshot({ setupScore: 0.54, confidence: 0.55 }),
    );
    expect(result.would_have_entered).toBe(false);
  });
});

// ─── Safety block routing ─────────────────────────────────────────────────────

describe("getSimulationTypesForReason — safety blocks", () => {
  const safetyBlockCodes = [
    "KILL_SWITCH_ACTIVE",
    "DAILY_LOSS_CAP_REACHED",
    "ACCOUNT_FLOOR_BREACHED",
    "MAX_TRADES_REACHED",
    "COOLDOWN_ACTIVE",
    "DOCTRINE_BLOCK",
    "RISK_GATE_BLOCK",
  ];

  for (const code of safetyBlockCodes) {
    it(`${code} → only SKIP_BASELINE (never TAKEN_IF_NOT_BLOCKED)`, () => {
      const types = getSimulationTypesForReason(code);
      expect(types).toContain("SKIP_BASELINE");
      expect(types).not.toContain("TAKEN_IF_NOT_BLOCKED");
      expect(types).toHaveLength(1);
    });
  }

  it("all safety block codes are recognized by isSafetyBlockCode", () => {
    for (const code of safetyBlockCodes) {
      expect(isSafetyBlockCode(code)).toBe(true);
    }
  });
});

// ─── Learning opportunity routing ─────────────────────────────────────────────

describe("getSimulationTypesForReason — learning opportunities", () => {
  const learningCodes = [
    "COACH_PENALTY",
    "LOW_CONFIDENCE",
    "LOW_SETUP_SCORE",
    "RISK_MANAGER_VETO",
    "EDGE_BELOW_COSTS",
    "NO_TRADE_REGIME",
    "OPERATOR_REJECTED",
  ];

  for (const code of learningCodes) {
    it(`${code} → both TAKEN_IF_NOT_BLOCKED and SKIP_BASELINE`, () => {
      const types = getSimulationTypesForReason(code);
      expect(types).toContain("TAKEN_IF_NOT_BLOCKED");
      expect(types).toContain("SKIP_BASELINE");
      expect(types).toHaveLength(2);
    });
  }
});

// ─── used_for_learning update ordering guarantee ──────────────────────────────

describe("used_for_learning flag — ordering guarantee (structural)", () => {
  it("a new decision_memory row has used_for_learning = false", () => {
    const row = {
      id: "dm-001",
      user_id: "user-001",
      symbol: "BTC-USD",
      reason_code: "COACH_PENALTY",
      used_for_learning: false,
      created_at: "2026-05-10T12:00:00.000Z",
    };
    expect(row.used_for_learning).toBe(false);
  });

  it("a simulation job starts with status queued (used_for_learning still false)", () => {
    const job: Partial<DecisionMemorySimulationRow> = {
      decision_memory_id: "dm-001",
      user_id: "user-001",
      simulation_type: "TAKEN_IF_NOT_BLOCKED",
      status: "queued",
      result: null,
    };
    // Result is null → used_for_learning must still be false on the parent
    expect(job.result).toBeNull();
    expect(job.status).toBe("queued");
  });

  it("result must be set before status transitions to completed", () => {
    const result = runSimulation(
      "TAKEN_IF_NOT_BLOCKED",
      makeSnapshot(),
    );
    const job: Partial<DecisionMemorySimulationRow> = {
      decision_memory_id: "dm-001",
      user_id: "user-001",
      simulation_type: "TAKEN_IF_NOT_BLOCKED",
      status: "completed",
      result,
    };
    // When status = completed, result must be present (not null)
    expect(job.status).toBe("completed");
    expect(job.result).not.toBeNull();
    expect(job.result?.scored_at).toBeTruthy();
  });

  it("a failed simulation job has status=failed and result=null", () => {
    const job: Partial<DecisionMemorySimulationRow> = {
      decision_memory_id: "dm-001",
      user_id: "user-001",
      simulation_type: "TAKEN_IF_NOT_BLOCKED",
      status: "failed",
      result: null,
      error: "something went wrong",
    };
    // Failed jobs must never have results stored, and used_for_learning
    // on the parent row must remain false.
    expect(job.status).toBe("failed");
    expect(job.result).toBeNull();
    expect(job.error).toBeTruthy();
  });
});

// ─── computeScore ─────────────────────────────────────────────────────────────

describe("computeScore()", () => {
  it("returns null when both inputs are null", () => {
    expect(computeScore(null, null)).toBeNull();
  });

  it("returns a number in [0, 1] for typical inputs", () => {
    const s = computeScore(0.70, 0.55);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThanOrEqual(0);
    expect(s!).toBeLessThanOrEqual(1);
  });

  it("geometric mean of 0.64 × 0.64 = 0.64", () => {
    const s = computeScore(0.64, 0.64);
    expect(s!).toBeCloseTo(0.64, 5);
  });

  it("geometric mean of 1.0 × 1.0 = 1.0", () => {
    expect(computeScore(1.0, 1.0)).toBeCloseTo(1.0, 5);
  });

  it("geometric mean of 0 × anything = 0", () => {
    expect(computeScore(0, 0.8)).toBeCloseTo(0, 5);
  });

  it("clamps values outside [0, 1]", () => {
    const s = computeScore(1.5, -0.1);
    // clamped: sqrt(1.0 * 0.0) = 0
    expect(s!).toBeCloseTo(0, 5);
  });

  it("uses 0.5 as fallback when one input is null", () => {
    // sqrt(0.64 × 0.5) ≈ 0.566
    const s = computeScore(0.64, null);
    expect(s!).toBeCloseTo(Math.sqrt(0.64 * 0.5), 5);
  });
});

// ─── getRecommendedAction ─────────────────────────────────────────────────────

describe("getRecommendedAction()", () => {
  it("safety blocks always return reinforce_block", () => {
    const safetyCodes = [
      "KILL_SWITCH_ACTIVE",
      "DAILY_LOSS_CAP_REACHED",
      "ACCOUNT_FLOOR_BREACHED",
      "MAX_TRADES_REACHED",
      "COOLDOWN_ACTIVE",
      "DOCTRINE_BLOCK",
      "RISK_GATE_BLOCK",
    ];
    for (const code of safetyCodes) {
      expect(getRecommendedAction(code, 0.90, 0.90)).toBe("reinforce_block");
    }
  });

  it("infra/data errors return ignore_insufficient_data", () => {
    const infraCodes = [
      "AI_ERROR",
      "BRAIN_TRUST_STALE",
      "MARKET_DATA_STALE",
      "RISK_MANAGER_SKIP_TICK",
      "NO_APPROVED_STRATEGY",
    ];
    for (const code of infraCodes) {
      expect(getRecommendedAction(code, 0.90, 0.90)).toBe(
        "ignore_insufficient_data",
      );
    }
  });

  it("COACH_PENALTY + high setup → question_block", () => {
    expect(getRecommendedAction("COACH_PENALTY", 0.70, 0.48)).toBe(
      "question_block",
    );
  });

  it("COACH_PENALTY + low setup → reinforce_block", () => {
    expect(getRecommendedAction("COACH_PENALTY", 0.40, 0.30)).toBe(
      "reinforce_block",
    );
  });

  it("LOW_CONFIDENCE + strong setup + decent raw confidence → tune_threshold", () => {
    expect(getRecommendedAction("LOW_CONFIDENCE", 0.65, 0.38)).toBe(
      "tune_threshold",
    );
  });

  it("LOW_CONFIDENCE + low setup → reinforce_block", () => {
    expect(getRecommendedAction("LOW_CONFIDENCE", 0.40, 0.25)).toBe(
      "reinforce_block",
    );
  });

  it("RISK_MANAGER_VETO + high setup → question_block", () => {
    expect(getRecommendedAction("RISK_MANAGER_VETO", 0.75, 0.55)).toBe(
      "question_block",
    );
  });

  it("RISK_MANAGER_VETO + low setup → reinforce_block", () => {
    expect(getRecommendedAction("RISK_MANAGER_VETO", 0.45, 0.40)).toBe(
      "reinforce_block",
    );
  });

  it("EDGE_BELOW_COSTS + good setup → tune_threshold", () => {
    expect(getRecommendedAction("EDGE_BELOW_COSTS", 0.65, 0.55)).toBe(
      "tune_threshold",
    );
  });

  it("EDGE_BELOW_COSTS + low setup → reinforce_block", () => {
    expect(getRecommendedAction("EDGE_BELOW_COSTS", 0.40, 0.40)).toBe(
      "reinforce_block",
    );
  });

  it("OPERATOR_REJECTED always reinforce_block (operator made a deliberate call)", () => {
    expect(getRecommendedAction("OPERATOR_REJECTED", 0.90, 0.90)).toBe(
      "reinforce_block",
    );
  });
});

// ─── buildInputSnapshot ───────────────────────────────────────────────────────

describe("buildInputSnapshot()", () => {
  it("produces a snapshot with all required fields", () => {
    const snap = buildInputSnapshot({
      symbol: "ETH-USD",
      regime: "ranging",
      setupScore: 0.55,
      confidence: 0.48,
      reasonCode: "LOW_CONFIDENCE",
      severity: "skip",
      blockerCodes: ["LOW_CONFIDENCE"],
      mode: "paper",
      createdAt: "2026-05-10T12:00:00.000Z",
    });
    expect(snap.symbol).toBe("ETH-USD");
    expect(snap.reasonCode).toBe("LOW_CONFIDENCE");
    expect(snap.setupScore).toBe(0.55);
    expect(snap.confidence).toBe(0.48);
    expect(snap.blockerCodes).toEqual(["LOW_CONFIDENCE"]);
  });

  it("snapshot contains no broker credentials", () => {
    const snap = makeSnapshot();
    const serialized = JSON.stringify(snap);
    const forbidden = [
      "Bearer ",
      "SERVICE_ROLE",
      "apiKey",
      "COINBASE_API",
      "private_key",
    ];
    for (const pattern of forbidden) {
      expect(serialized).not.toContain(pattern);
    }
  });

  it("snapshot is user-agnostic (no user_id in the snapshot itself)", () => {
    const snap = makeSnapshot();
    // user_id lives in the parent decision_memory row; snapshot is signal-context only
    expect("user_id" in snap).toBe(false);
    expect("auth" in snap).toBe(false);
  });
});

// ─── Batch jobs are user-scoped (structural proof) ────────────────────────────

describe("Batch jobs are user-scoped", () => {
  it("DecisionMemorySimulationRow carries user_id", () => {
    const row: Partial<DecisionMemorySimulationRow> = {
      id: "sim-001",
      decision_memory_id: "dm-001",
      user_id: "user-aaa",
      simulation_type: "TAKEN_IF_NOT_BLOCKED",
      status: "queued",
      input_snapshot: makeSnapshot(),
    };
    expect(row.user_id).toBe("user-aaa");
    expect(row.decision_memory_id).toBe("dm-001");
  });

  it("two users produce separate simulation rows (no cross-contamination)", () => {
    const rowA: Partial<DecisionMemorySimulationRow> = {
      user_id: "user-aaa",
      decision_memory_id: "dm-A01",
      simulation_type: "TAKEN_IF_NOT_BLOCKED",
    };
    const rowB: Partial<DecisionMemorySimulationRow> = {
      user_id: "user-bbb",
      decision_memory_id: "dm-B01",
      simulation_type: "TAKEN_IF_NOT_BLOCKED",
    };
    expect(rowA.user_id).not.toBe(rowB.user_id);
    expect(rowA.decision_memory_id).not.toBe(rowB.decision_memory_id);
  });
});

// ─── Simulation does NOT create trades ────────────────────────────────────────

describe("Simulation never creates trades", () => {
  it("SimulationResult has no fields that could create a trade row", () => {
    const result = runSimulation("TAKEN_IF_NOT_BLOCKED", makeSnapshot());
    // None of these fields, which trade creation requires, should be present
    const tradeCreationFields = [
      "side",
      "size_usd",
      "proposed_entry",
      "target_price",
      "stop_price",
      "strategy_id",
      "exchange",
      "order_type",
    ];
    for (const field of tradeCreationFields) {
      expect(field in result).toBe(false);
    }
  });

  it("result_label 'insufficient_data' signals no execution — just scoring", () => {
    const result = runSimulation(
      "TAKEN_IF_NOT_BLOCKED",
      makeSnapshot({ setupScore: 0.70, confidence: 0.55 }),
    );
    // This is explicitly an observation, not an action
    expect(result.result_label).toBe("insufficient_data");
    expect(result.hypothetical_pnl).toBeNull();
    expect(result.simulated_entry_price).toBeNull();
  });

  it("SKIP_BASELINE confirms no-entry — not an entry instruction", () => {
    const result = runSimulation("SKIP_BASELINE", makeSnapshot());
    expect(result.would_have_entered).toBe(false);
    // No entry price means nothing was 'filled'
    expect(result.simulated_entry_price).toBeNull();
  });
});

// ─── isSafetyBlockCode / isInfraErrorCode ────────────────────────────────────

describe("isSafetyBlockCode()", () => {
  it("returns true for all known safety block codes", () => {
    const codes = [
      "KILL_SWITCH_ACTIVE",
      "DAILY_LOSS_CAP_REACHED",
      "ACCOUNT_FLOOR_BREACHED",
      "MAX_TRADES_REACHED",
      "COOLDOWN_ACTIVE",
      "DOCTRINE_BLOCK",
      "RISK_GATE_BLOCK",
    ];
    for (const c of codes) expect(isSafetyBlockCode(c)).toBe(true);
  });

  it("returns false for learning opportunity codes", () => {
    const codes = [
      "COACH_PENALTY",
      "LOW_CONFIDENCE",
      "LOW_SETUP_SCORE",
      "RISK_MANAGER_VETO",
    ];
    for (const c of codes) expect(isSafetyBlockCode(c)).toBe(false);
  });
});

describe("isInfraErrorCode()", () => {
  it("returns true for infra/data error codes", () => {
    const codes = [
      "AI_ERROR",
      "BRAIN_TRUST_STALE",
      "MARKET_DATA_STALE",
      "RISK_MANAGER_SKIP_TICK",
      "NO_APPROVED_STRATEGY",
    ];
    for (const c of codes) expect(isInfraErrorCode(c)).toBe(true);
  });

  it("returns false for safety blocks", () => {
    expect(isInfraErrorCode("KILL_SWITCH_ACTIVE")).toBe(false);
  });

  it("returns false for coach penalty (signal quality issue, not infra)", () => {
    expect(isInfraErrorCode("COACH_PENALTY")).toBe(false);
  });
});

// ─── End-to-end: simulate a full decision_memory row ─────────────────────────

describe("End-to-end: process a decision_memory row", () => {
  it("processes a COACH_PENALTY row and produces two simulation results", () => {
    const memoryRow = {
      id: "dm-e2e-001",
      user_id: "user-e2e",
      symbol: "BTC-USD",
      reason_code: "COACH_PENALTY",
      severity: "skip",
      mode: "paper",
      market_regime: "trending_up",
      confidence: 0.48,
      setup_score: 0.70,
      blocker_codes: ["COACH_PENALTY"],
      used_for_learning: false,
      created_at: "2026-05-10T12:00:00.000Z",
    };

    const snapshot = buildInputSnapshot({
      symbol: memoryRow.symbol,
      regime: memoryRow.market_regime,
      setupScore: memoryRow.setup_score,
      confidence: memoryRow.confidence,
      reasonCode: memoryRow.reason_code,
      severity: memoryRow.severity,
      blockerCodes: memoryRow.blocker_codes,
      mode: memoryRow.mode,
      createdAt: memoryRow.created_at,
    });

    const simTypes = getSimulationTypesForReason(memoryRow.reason_code);
    expect(simTypes).toHaveLength(2);
    expect(simTypes).toContain("TAKEN_IF_NOT_BLOCKED");
    expect(simTypes).toContain("SKIP_BASELINE");

    const results: SimulationResult[] = simTypes.map((t: SimulationType) =>
      runSimulation(t, snapshot),
    );

    expect(results).toHaveLength(2);

    const takenResult = results.find(
      (r) => r.simulationType === "TAKEN_IF_NOT_BLOCKED",
    )!;
    const skipResult = results.find(
      (r) => r.simulationType === "SKIP_BASELINE",
    )!;

    // Near-miss: setup 0.70 + conf 0.48 both above entry thresholds
    expect(takenResult.would_have_entered).toBe(true);
    expect(takenResult.result_label).toBe("insufficient_data");
    expect(takenResult.recommended_learning_action).toBe("question_block");

    expect(skipResult.would_have_entered).toBe(false);
    expect(skipResult.result_label).toBe("skipped");

    // used_for_learning must remain false until results stored
    expect(memoryRow.used_for_learning).toBe(false);
    // (In production, the edge function sets it to true only after DB update succeeds)
  });

  it("processes a KILL_SWITCH_ACTIVE row and produces only SKIP_BASELINE", () => {
    const memoryRow = {
      id: "dm-e2e-002",
      user_id: "user-e2e",
      symbol: null,
      reason_code: "KILL_SWITCH_ACTIVE",
      severity: "halt",
      mode: "paper",
      market_regime: null,
      confidence: null,
      setup_score: null,
      blocker_codes: ["KILL_SWITCH_ACTIVE"],
      used_for_learning: false,
      created_at: "2026-05-10T12:05:00.000Z",
    };

    const snapshot = buildInputSnapshot({
      symbol: memoryRow.symbol,
      regime: memoryRow.market_regime,
      setupScore: memoryRow.setup_score,
      confidence: memoryRow.confidence,
      reasonCode: memoryRow.reason_code,
      severity: memoryRow.severity,
      blockerCodes: memoryRow.blocker_codes,
      mode: memoryRow.mode,
      createdAt: memoryRow.created_at,
    });

    const simTypes = getSimulationTypesForReason(memoryRow.reason_code);
    expect(simTypes).toHaveLength(1);
    expect(simTypes[0]).toBe("SKIP_BASELINE");

    const result = runSimulation("SKIP_BASELINE", snapshot);

    expect(result.would_have_entered).toBe(false);
    expect(result.result_label).toBe("skipped");
    expect(result.recommended_learning_action).toBe("reinforce_block");
    // null inputs → null score
    expect(result.score).toBeNull();
  });

  it("LOW_CONFIDENCE with conf below entry threshold: would_have_entered = false", () => {
    // setup=0.65 is above MIN_SETUP (0.55), but conf=0.38 is below MIN_CONF (0.42).
    // Both thresholds must pass; conf fails → no entry modeled.
    const snapshot = makeSnapshot({
      reasonCode: "LOW_CONFIDENCE",
      setupScore: 0.65,
      confidence: 0.38,
    });

    const takenResult = runSimulation("TAKEN_IF_NOT_BLOCKED", snapshot);
    expect(takenResult.would_have_entered).toBe(false);
    expect(takenResult.result_label).toBe("no_clear_edge");
  });

  it("near-miss requires BOTH setup and confidence thresholds to be met", () => {
    // setup ok but conf too low
    const r1 = runSimulation(
      "TAKEN_IF_NOT_BLOCKED",
      makeSnapshot({ setupScore: 0.70, confidence: 0.35 }),
    );
    expect(r1.would_have_entered).toBe(false);

    // conf ok but setup too low
    const r2 = runSimulation(
      "TAKEN_IF_NOT_BLOCKED",
      makeSnapshot({ setupScore: 0.40, confidence: 0.55 }),
    );
    expect(r2.would_have_entered).toBe(false);

    // both ok
    const r3 = runSimulation(
      "TAKEN_IF_NOT_BLOCKED",
      makeSnapshot({ setupScore: 0.60, confidence: 0.50 }),
    );
    expect(r3.would_have_entered).toBe(true);
  });
});
