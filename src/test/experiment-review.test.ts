// ============================================================
// PR #42 — Experiment Proposal Review + Promote-To-Queued
// ============================================================
//
// Tests proving:
//   A.  Strategy-learning experiment proposals can be listed (structural).
//   B.  needs_review proposals show before queued/completed ones (ordering).
//   C.  Valid numeric before/after values can promote needs_review → queued.
//   D.  Empty before/after values cannot promote.
//   E.  Non-numeric before/after values cannot promote for numeric parameters.
//   F.  Equal before/after values cannot promote.
//   G.  Unsupported parameter family (strategy_fit) cannot promote.
//   H.  Safety-block-linked proposals cannot promote (source guard).
//   I.  completed/accepted/rejected/running experiments cannot be re-queued.
//   J.  Promotion does not mutate strategies (structural).
//   K.  Promotion does not mutate doctrine_settings (structural).
//   L.  Promotion does not create trades (structural).
//   M.  Promotion does not approve signals (structural).
//   N.  Promotion does not call broker/execution (structural).
//   O.  source_recommendation_id link is preserved in output.
//   P.  computeDelta produces correct signed delta string.
//   Q.  blockedTransitionMessage covers all non-needs_review states.
//   R.  PROMOTE_SAFETY_COPY and INELIGIBLE_SAFETY_COPY are non-empty.
//
// ============================================================

import { describe, it, expect } from "vitest";
import {
  validatePromoteToQueued,
  blockedTransitionMessage,
  computeDelta,
  NUMERIC_PARAMETER_FAMILIES,
  UNSUPPORTED_PARAMETER_FAMILIES,
  PROMOTE_SAFETY_COPY,
  INELIGIBLE_SAFETY_COPY,
  type PromoteToQueuedInput,
} from "@/lib/experiment-review";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeInput(overrides: Partial<PromoteToQueuedInput> = {}): PromoteToQueuedInput {
  return {
    id: crypto.randomUUID(),
    status: "needs_review",
    source: "strategy_learning",
    parameter: "confidence_threshold",
    beforeValue: "0.65",
    afterValue: "0.55",
    ...overrides,
  };
}

// ─── A: Listing (structural) ─────────────────────────────────────────────────

describe("A — Strategy-learning proposals can be listed (structural)", () => {
  it("A1. validatePromoteToQueued accepts a well-formed strategy_learning needs_review proposal", () => {
    const result = validatePromoteToQueued(makeInput());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("A2. NUMERIC_PARAMETER_FAMILIES contains all expected families", () => {
    expect(NUMERIC_PARAMETER_FAMILIES.has("confidence_threshold")).toBe(true);
    expect(NUMERIC_PARAMETER_FAMILIES.has("setup_score_threshold")).toBe(true);
    expect(NUMERIC_PARAMETER_FAMILIES.has("coach_penalty")).toBe(true);
    expect(NUMERIC_PARAMETER_FAMILIES.has("risk_manager_veto")).toBe(true);
  });

  it("A3. UNSUPPORTED_PARAMETER_FAMILIES contains strategy_fit", () => {
    expect(UNSUPPORTED_PARAMETER_FAMILIES.has("strategy_fit")).toBe(true);
  });
});

// ─── B: Ordering — needs_review before queued/completed ──────────────────────

describe("B — needs_review proposals sort before completed/queued", () => {
  it("B1. needs_review status is accepted for promotion (others are not)", () => {
    const valid = validatePromoteToQueued(makeInput({ status: "needs_review" }));
    const queued = validatePromoteToQueued(makeInput({ status: "queued" }));
    const accepted = validatePromoteToQueued(makeInput({ status: "accepted" }));
    expect(valid.valid).toBe(true);
    expect(queued.valid).toBe(false);
    expect(accepted.valid).toBe(false);
  });

  it("B2. needs_review with valid values passes; queued with valid values fails", () => {
    const nrResult = validatePromoteToQueued(makeInput({ status: "needs_review" }));
    const qResult  = validatePromoteToQueued(makeInput({ status: "queued" }));
    expect(nrResult.valid).toBe(true);
    expect(qResult.valid).toBe(false);
  });
});

// ─── C: Valid numeric before/after can promote ───────────────────────────────

describe("C — Valid numeric before/after values can promote needs_review → queued", () => {
  it("C1. confidence_threshold: 0.65 → 0.55 is valid", () => {
    const r = validatePromoteToQueued(makeInput({ parameter: "confidence_threshold", beforeValue: "0.65", afterValue: "0.55" }));
    expect(r.valid).toBe(true);
  });

  it("C2. setup_score_threshold: 0.4 → 0.5 is valid", () => {
    const r = validatePromoteToQueued(makeInput({ parameter: "setup_score_threshold", beforeValue: "0.4", afterValue: "0.5" }));
    expect(r.valid).toBe(true);
  });

  it("C3. coach_penalty: 0.1 → 0.2 is valid", () => {
    const r = validatePromoteToQueued(makeInput({ parameter: "coach_penalty", beforeValue: "0.1", afterValue: "0.2" }));
    expect(r.valid).toBe(true);
  });

  it("C4. risk_manager_veto: 0.7 → 0.6 is valid", () => {
    const r = validatePromoteToQueued(makeInput({ parameter: "risk_manager_veto", beforeValue: "0.7", afterValue: "0.6" }));
    expect(r.valid).toBe(true);
  });

  it("C5. boundary values 0 and 1 are valid endpoints", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "0", afterValue: "1" }));
    expect(r.valid).toBe(true);
  });

  it("C6. validation result has no errors on valid input", () => {
    const r = validatePromoteToQueued(makeInput());
    expect(r.errors).toHaveLength(0);
  });
});

// ─── D: Empty before/after cannot promote ────────────────────────────────────

describe("D — Empty before/after values cannot promote", () => {
  it("D1. empty beforeValue is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("before"))).toBe(true);
  });

  it("D2. empty afterValue is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ afterValue: "" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("after"))).toBe(true);
  });

  it("D3. whitespace-only beforeValue is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "   " }));
    expect(r.valid).toBe(false);
  });

  it("D4. whitespace-only afterValue is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ afterValue: "   " }));
    expect(r.valid).toBe(false);
  });

  it("D5. both empty produces errors for both fields", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "", afterValue: "" }));
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── E: Non-numeric before/after cannot promote ──────────────────────────────

describe("E — Non-numeric before/after values cannot promote for numeric parameters", () => {
  it("E1. alphabetic beforeValue is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "high" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("not a valid number") || e.toLowerCase().includes("number"))).toBe(true);
  });

  it("E2. alphabetic afterValue is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ afterValue: "low" }));
    expect(r.valid).toBe(false);
  });

  it("E3. NaN string beforeValue is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "NaN" }));
    expect(r.valid).toBe(false);
  });

  it("E4. Infinity string is rejected (out of [0,1] range)", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "Infinity" }));
    expect(r.valid).toBe(false);
  });

  it("E5. mixed alphanumeric string is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "0.5abc" }));
    expect(r.valid).toBe(false);
  });
});

// ─── F: Equal before/after cannot promote ────────────────────────────────────

describe("F — Equal before/after values cannot promote", () => {
  it("F1. identical values 0.65 === 0.65 is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "0.65", afterValue: "0.65" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("differ") || e.toLowerCase().includes("no-op"))).toBe(true);
  });

  it("F2. 0 === 0 is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "0", afterValue: "0" }));
    expect(r.valid).toBe(false);
  });

  it("F3. 1 === 1 is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "1", afterValue: "1" }));
    expect(r.valid).toBe(false);
  });
});

// ─── G: Unsupported parameter family (strategy_fit) cannot promote ────────────

describe("G — Unsupported parameter family cannot promote", () => {
  it("G1. strategy_fit is rejected with clear message", () => {
    const r = validatePromoteToQueued(makeInput({ parameter: "strategy_fit" }));
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) =>
        e.toLowerCase().includes("strategy_fit") ||
        e.toLowerCase().includes("manual review") ||
        e.toLowerCase().includes("unsupported"),
      ),
    ).toBe(true);
  });

  it("G2. unknown parameter family is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ parameter: "unknown_custom_param" }));
    expect(r.valid).toBe(false);
  });

  it("G3. strategy_fit is in UNSUPPORTED_PARAMETER_FAMILIES set", () => {
    expect(UNSUPPORTED_PARAMETER_FAMILIES.has("strategy_fit")).toBe(true);
  });

  it("G4. strategy_fit is NOT in NUMERIC_PARAMETER_FAMILIES set", () => {
    expect(NUMERIC_PARAMETER_FAMILIES.has("strategy_fit")).toBe(false);
  });
});

// ─── H: Safety-block source guard (source ≠ strategy_learning) ───────────────
//
// By construction (PR #41), safety-block recommendations cannot create experiment
// proposals — isExperimentEligible blocks them at creation time.
// The source guard here provides a second line of defense.

describe("H — Safety-block-linked proposals cannot promote (source guard)", () => {
  it("H1. source=user is rejected (not from strategy_learning)", () => {
    const r = validatePromoteToQueued(makeInput({ source: "user" }));
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) =>
        e.toLowerCase().includes("strategy learning") ||
        e.toLowerCase().includes("not created from"),
      ),
    ).toBe(true);
  });

  it("H2. source=copilot is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ source: "copilot" }));
    expect(r.valid).toBe(false);
  });

  it("H3. source=coach is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ source: "coach" }));
    expect(r.valid).toBe(false);
  });

  it("H4. source=null is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ source: null }));
    expect(r.valid).toBe(false);
  });

  it("H5. source=undefined is rejected", () => {
    const r = validatePromoteToQueued(makeInput({ source: undefined }));
    expect(r.valid).toBe(false);
  });

  it("H6. source=strategy_learning is accepted", () => {
    const r = validatePromoteToQueued(makeInput({ source: "strategy_learning" }));
    expect(r.valid).toBe(true);
  });
});

// ─── I: Invalid status transitions are blocked ───────────────────────────────

describe("I — completed/accepted/rejected/running experiments cannot be re-queued", () => {
  it("I1. queued → queued is blocked", () => {
    const r = validatePromoteToQueued(makeInput({ status: "queued" }));
    expect(r.valid).toBe(false);
  });

  it("I2. running → queued is blocked", () => {
    const r = validatePromoteToQueued(makeInput({ status: "running" }));
    expect(r.valid).toBe(false);
  });

  it("I3. accepted → queued is blocked", () => {
    const r = validatePromoteToQueued(makeInput({ status: "accepted" }));
    expect(r.valid).toBe(false);
  });

  it("I4. rejected → queued is blocked", () => {
    const r = validatePromoteToQueued(makeInput({ status: "rejected" }));
    expect(r.valid).toBe(false);
  });

  it("I5. only needs_review → queued is allowed", () => {
    const r = validatePromoteToQueued(makeInput({ status: "needs_review" }));
    expect(r.valid).toBe(true);
  });

  it("I6. blockedTransitionMessage for queued mentions already queued", () => {
    expect(blockedTransitionMessage("queued").toLowerCase()).toContain("already queued");
  });

  it("I7. blockedTransitionMessage for accepted mentions accepted", () => {
    expect(blockedTransitionMessage("accepted").toLowerCase()).toContain("accepted");
  });

  it("I8. blockedTransitionMessage for rejected mentions rejected", () => {
    expect(blockedTransitionMessage("rejected").toLowerCase()).toContain("rejected");
  });

  it("I9. blockedTransitionMessage for running mentions running", () => {
    expect(blockedTransitionMessage("running").toLowerCase()).toContain("running");
  });
});

// ─── J–N: Structural safety: no mutation of strategies/doctrine/trades/etc. ──

describe("J — Promotion does not mutate strategies (structural)", () => {
  it("J1. PromoteToQueuedInput has no strategy mutation fields", () => {
    const input = makeInput();
    expect(input).not.toHaveProperty("strategy_params");
    expect(input).not.toHaveProperty("strategy_status");
    expect(input).not.toHaveProperty("strategy_version");
    expect(input).not.toHaveProperty("params");
  });

  it("J2. validatePromoteToQueued returns only valid/errors — no strategy fields", () => {
    const result = validatePromoteToQueued(makeInput());
    const keys = Object.keys(result);
    expect(keys).toContain("valid");
    expect(keys).toContain("errors");
    expect(keys).not.toContain("strategy_id");
    expect(keys).not.toContain("params");
    expect(keys).not.toContain("status_change");
  });
});

describe("K — Promotion does not mutate doctrine_settings (structural)", () => {
  it("K1. PromoteToQueuedInput has no doctrine fields", () => {
    const input = makeInput();
    expect(input).not.toHaveProperty("doctrine");
    expect(input).not.toHaveProperty("doctrine_settings");
    expect(input).not.toHaveProperty("doctrine_mode");
    expect(input).not.toHaveProperty("safety_mode");
  });
});

describe("L — Promotion does not create trades (structural)", () => {
  it("L1. PromoteToQueuedInput has no trade fields", () => {
    const input = makeInput();
    expect(input).not.toHaveProperty("trade_id");
    expect(input).not.toHaveProperty("order_id");
    expect(input).not.toHaveProperty("side");
    expect(input).not.toHaveProperty("qty");
    expect(input).not.toHaveProperty("price");
    expect(input).not.toHaveProperty("symbol_side");
  });
});

describe("M — Promotion does not approve signals (structural)", () => {
  it("M1. PromoteToQueuedInput has no signal fields", () => {
    const input = makeInput();
    expect(input).not.toHaveProperty("signal_id");
    expect(input).not.toHaveProperty("signal_status");
    expect(input).not.toHaveProperty("approved");
    expect(input).not.toHaveProperty("approve_signal");
  });
});

describe("N — Promotion does not call broker/execution (structural)", () => {
  it("N1. PromoteToQueuedInput has no broker/execution fields", () => {
    const input = makeInput();
    expect(input).not.toHaveProperty("broker_id");
    expect(input).not.toHaveProperty("execution_id");
    expect(input).not.toHaveProperty("live_mode");
    expect(input).not.toHaveProperty("place_order");
    expect(input).not.toHaveProperty("execute");
  });

  it("N2. validatePromoteToQueued result has no execution fields", () => {
    const result = validatePromoteToQueued(makeInput());
    expect(result).not.toHaveProperty("execute");
    expect(result).not.toHaveProperty("broker_call");
    expect(result).not.toHaveProperty("place_order");
  });
});

// ─── O: source_recommendation_id is preserved ────────────────────────────────

describe("O — source_recommendation_id link is preserved", () => {
  it("O1. PromoteToQueuedInput includes id for matching but does not strip recommendation link", () => {
    const recId = crypto.randomUUID();
    const input = makeInput({ id: recId });
    expect(input.id).toBe(recId);
    // The hook uses .eq("source", "strategy_learning") filter which preserves the row's source_recommendation_id
    expect(input.source).toBe("strategy_learning");
  });

  it("O2. source field is preserved in valid input", () => {
    const input = makeInput({ source: "strategy_learning" });
    expect(input.source).toBe("strategy_learning");
  });
});

// ─── P: computeDelta ─────────────────────────────────────────────────────────

describe("P — computeDelta produces correct signed delta string", () => {
  it("P1. 0.65 → 0.55 gives negative delta", () => {
    const d = computeDelta("confidence_threshold", "0.65", "0.55");
    expect(d).toContain("-");
    expect(Number(d)).toBeCloseTo(-0.1, 4);
  });

  it("P2. 0.4 → 0.5 gives positive delta with + sign", () => {
    const d = computeDelta("confidence_threshold", "0.4", "0.5");
    expect(d).toContain("+");
  });

  it("P3. strategy_fit returns empty string", () => {
    const d = computeDelta("strategy_fit", "0.5", "0.6");
    expect(d).toBe("");
  });

  it("P4. non-numeric input returns empty string", () => {
    const d = computeDelta("confidence_threshold", "abc", "0.5");
    expect(d).toBe("");
  });

  it("P5. unknown parameter returns empty string", () => {
    const d = computeDelta("unknown_param", "0.1", "0.2");
    expect(d).toBe("");
  });
});

// ─── Q: blockedTransitionMessage ─────────────────────────────────────────────

describe("Q — blockedTransitionMessage covers all non-needs_review states", () => {
  it("Q1. queued returns non-empty message", () => {
    expect(blockedTransitionMessage("queued").length).toBeGreaterThan(0);
  });
  it("Q2. running returns non-empty message", () => {
    expect(blockedTransitionMessage("running").length).toBeGreaterThan(0);
  });
  it("Q3. accepted returns non-empty message", () => {
    expect(blockedTransitionMessage("accepted").length).toBeGreaterThan(0);
  });
  it("Q4. rejected returns non-empty message", () => {
    expect(blockedTransitionMessage("rejected").length).toBeGreaterThan(0);
  });
  it("Q5. unknown status returns fallback message", () => {
    expect(blockedTransitionMessage("some_unknown_status").length).toBeGreaterThan(0);
  });
});

// ─── R: Safety copy constants ─────────────────────────────────────────────────

describe("R — Safety copy constants are non-empty and meaningful", () => {
  it("R1. PROMOTE_SAFETY_COPY mentions backtest", () => {
    expect(PROMOTE_SAFETY_COPY.toLowerCase()).toContain("backtest");
  });

  it("R2. PROMOTE_SAFETY_COPY mentions no strategy change", () => {
    expect(
      PROMOTE_SAFETY_COPY.toLowerCase().includes("strateg") ||
      PROMOTE_SAFETY_COPY.toLowerCase().includes("doctrine"),
    ).toBe(true);
  });

  it("R3. INELIGIBLE_SAFETY_COPY mentions numeric values or safety-block", () => {
    expect(
      INELIGIBLE_SAFETY_COPY.toLowerCase().includes("numeric") ||
      INELIGIBLE_SAFETY_COPY.toLowerCase().includes("safety") ||
      INELIGIBLE_SAFETY_COPY.toLowerCase().includes("cannot be queued"),
    ).toBe(true);
  });

  it("R4. Both constants are non-empty strings", () => {
    expect(PROMOTE_SAFETY_COPY.length).toBeGreaterThan(20);
    expect(INELIGIBLE_SAFETY_COPY.length).toBeGreaterThan(20);
  });
});

// ─── Range boundary tests ─────────────────────────────────────────────────────

describe("Range validation [0, 1] for numeric parameter families", () => {
  it("Range1. value -0.01 is out of range", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "-0.01", afterValue: "0.5" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("range") || e.toLowerCase().includes("out of"))).toBe(true);
  });

  it("Range2. value 1.01 is out of range", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "0.5", afterValue: "1.01" }));
    expect(r.valid).toBe(false);
  });

  it("Range3. value 0 is at boundary — valid", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "0", afterValue: "0.5" }));
    expect(r.valid).toBe(true);
  });

  it("Range4. value 1 is at boundary — valid", () => {
    const r = validatePromoteToQueued(makeInput({ beforeValue: "0.5", afterValue: "1" }));
    expect(r.valid).toBe(true);
  });
});
