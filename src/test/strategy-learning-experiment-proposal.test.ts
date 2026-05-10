// ============================================================
// PR #41 — Accepted Recommendation → Queued Experiment Proposal
// ============================================================
//
//  1.  Accepted TUNE_THRESHOLD → eligible for experiment proposal.
//  2.  Accepted QUESTION_BLOCKER → eligible for experiment proposal.
//  3.  Accepted REVIEW_STRATEGY_FIT → eligible for experiment proposal.
//  4.  REINFORCE_BLOCKER → NOT eligible.
//  5.  INSUFFICIENT_EVIDENCE → NOT eligible.
//  6.  Safety-block reason code (KILL_SWITCH_ACTIVE) → NOT eligible.
//  7.  Safety-block reason code (DAILY_LOSS_CAP_REACHED) → NOT eligible.
//  8.  Safety-block reason code (ACCOUNT_FLOOR_BREACHED) → NOT eligible.
//  9.  Safety-block reason code (MAX_TRADES_REACHED) → NOT eligible.
// 10.  Safety-block reason code (COOLDOWN_ACTIVE) → NOT eligible.
// 11.  Safety-block reason code (DOCTRINE_BLOCK) → NOT eligible.
// 12.  Safety-block reason code (RISK_GATE_BLOCK) → NOT eligible.
// 13.  pending_review status → NOT eligible (must be accepted).
// 14.  rejected status → NOT eligible.
// 15.  deferred status → NOT eligible.
// 16.  buildExperimentProposalInput returns status='needs_review'.
// 17.  buildExperimentProposalInput returns proposed_by='strategy_learning'.
// 18.  buildExperimentProposalInput returns source='strategy_learning'.
// 19.  buildExperimentProposalInput links source_recommendation_id.
// 20.  buildExperimentProposalInput does NOT mutate strategies (structural).
// 21.  buildExperimentProposalInput does NOT mutate doctrine (structural).
// 22.  buildExperimentProposalInput does NOT create trades (structural).
// 23.  buildExperimentProposalInput does NOT approve signals (structural).
// 24.  LOW_CONFIDENCE reason_code → parameter family = confidence_threshold.
// 25.  LOW_SETUP_SCORE reason_code → parameter family = setup_score_threshold.
// 26.  COACH_PENALTY reason_code → parameter family = coach_penalty.
// 27.  RISK_MANAGER_VETO reason_code → parameter family = risk_manager_veto.
// 28.  Unknown reason_code → parameter family = strategy_fit.
// 29.  Hypothesis includes recommendation text.
// 30.  Hypothesis includes reason_code.
// 31.  Proposal notes state this is research-only.
// 32.  Proposal before_value is empty string (reviewer fills in).
// 33.  Proposal after_value is empty string (reviewer fills in).
// 34.  UI safety copy — "does not change strategy behavior" in proposal notes.
// 35.  Duplicate: isExperimentEligible respects recommendation_type gate.
// 36.  SAFETY_BLOCK_REASON_CODES set is exported and complete.
// 37.  EXPERIMENT_ELIGIBLE_TYPES set is exported and matches spec.
// 38.  reasonCodeToParameterFamily is deterministic.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  isExperimentEligible,
  buildExperimentProposalInput,
  reasonCodeToParameterFamily,
  SAFETY_BLOCK_REASON_CODES,
  EXPERIMENT_ELIGIBLE_TYPES,
} from "@/lib/strategy-learning";
import type { RecommendationType } from "@/lib/strategy-learning";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeRec(overrides: {
  recommendation_type?: RecommendationType;
  reason_code?: string;
  status?: string;
} = {}) {
  return {
    id: crypto.randomUUID(),
    user_id: "user-test",
    recommendation_type: (overrides.recommendation_type ?? "TUNE_THRESHOLD") as RecommendationType,
    reason_code: overrides.reason_code ?? "LOW_CONFIDENCE",
    status: overrides.status ?? "accepted",
    symbol: "BTC-USD",
    strategy_id: null,
    market_regime: "trending_up",
    confidence: 0.78,
    evidence_count: 15,
    recommendation: "Review confidence threshold for BTC-USD: 10/15 blocked signals moved favorably.",
  };
}

// ─── Eligibility tests ────────────────────────────────────────────────────────

describe("isExperimentEligible — eligible types", () => {
  it("1. Accepted TUNE_THRESHOLD is eligible", () => {
    expect(isExperimentEligible(makeRec({ recommendation_type: "TUNE_THRESHOLD", status: "accepted" }))).toBe(true);
  });

  it("2. Accepted QUESTION_BLOCKER is eligible", () => {
    expect(isExperimentEligible(makeRec({ recommendation_type: "QUESTION_BLOCKER", reason_code: "COACH_PENALTY", status: "accepted" }))).toBe(true);
  });

  it("3. Accepted REVIEW_STRATEGY_FIT is eligible", () => {
    expect(isExperimentEligible(makeRec({ recommendation_type: "REVIEW_STRATEGY_FIT", status: "accepted" }))).toBe(true);
  });
});

describe("isExperimentEligible — ineligible types", () => {
  it("4. REINFORCE_BLOCKER is NOT eligible", () => {
    expect(isExperimentEligible(makeRec({ recommendation_type: "REINFORCE_BLOCKER", status: "accepted" }))).toBe(false);
  });

  it("5. INSUFFICIENT_EVIDENCE is NOT eligible", () => {
    expect(isExperimentEligible(makeRec({ recommendation_type: "INSUFFICIENT_EVIDENCE", status: "accepted" }))).toBe(false);
  });
});

describe("isExperimentEligible — safety block reason codes", () => {
  const safetyTypes: Array<[string, string]> = [
    ["6", "KILL_SWITCH_ACTIVE"],
    ["7", "DAILY_LOSS_CAP_REACHED"],
    ["8", "ACCOUNT_FLOOR_BREACHED"],
    ["9", "MAX_TRADES_REACHED"],
    ["10", "COOLDOWN_ACTIVE"],
    ["11", "DOCTRINE_BLOCK"],
    ["12", "RISK_GATE_BLOCK"],
  ];

  for (const [num, code] of safetyTypes) {
    it(`${num}. ${code} → NOT eligible even if TUNE_THRESHOLD`, () => {
      expect(
        isExperimentEligible({
          recommendation_type: "TUNE_THRESHOLD",
          reason_code: code,
          status: "accepted",
        }),
      ).toBe(false);
    });
  }
});

describe("isExperimentEligible — status guards", () => {
  it("13. pending_review → NOT eligible", () => {
    expect(isExperimentEligible(makeRec({ status: "pending_review" }))).toBe(false);
  });

  it("14. rejected → NOT eligible", () => {
    expect(isExperimentEligible(makeRec({ status: "rejected" }))).toBe(false);
  });

  it("15. deferred → NOT eligible", () => {
    expect(isExperimentEligible(makeRec({ status: "deferred" }))).toBe(false);
  });
});

// ─── buildExperimentProposalInput tests ───────────────────────────────────────

describe("buildExperimentProposalInput — safety fields", () => {
  const rec = makeRec();
  const proposal = buildExperimentProposalInput(rec);

  it("16. status is needs_review", () => {
    expect(proposal.status).toBe("needs_review");
  });

  it("17. proposed_by is strategy_learning", () => {
    expect(proposal.proposed_by).toBe("strategy_learning");
  });

  it("18. source is strategy_learning", () => {
    expect(proposal.source).toBe("strategy_learning");
  });

  it("19. links source_recommendation_id to recommendation id", () => {
    expect(proposal.source_recommendation_id).toBe(rec.id);
  });

  it("20. does NOT mutate strategies — proposal has no strategy mutation fields", () => {
    // Structural: proposal input has no fields that could alter strategy params/status
    expect(proposal).not.toHaveProperty("strategy_params");
    expect(proposal).not.toHaveProperty("strategy_status");
    expect(proposal).not.toHaveProperty("strategy_version");
  });

  it("21. does NOT mutate doctrine — proposal has no doctrine fields", () => {
    expect(proposal).not.toHaveProperty("doctrine");
    expect(proposal).not.toHaveProperty("doctrine_settings");
    expect(proposal).not.toHaveProperty("doctrine_mode");
  });

  it("22. does NOT create trades — proposal has no trade fields", () => {
    expect(proposal).not.toHaveProperty("trade_id");
    expect(proposal).not.toHaveProperty("order_id");
    expect(proposal).not.toHaveProperty("side");
    expect(proposal).not.toHaveProperty("qty");
    expect(proposal).not.toHaveProperty("price");
  });

  it("23. does NOT approve signals — proposal has no signal fields", () => {
    expect(proposal).not.toHaveProperty("signal_id");
    expect(proposal).not.toHaveProperty("signal_status");
    expect(proposal).not.toHaveProperty("approved");
  });

  it("32. before_value is empty string", () => {
    expect(proposal.before_value).toBe("");
  });

  it("33. after_value is empty string", () => {
    expect(proposal.after_value).toBe("");
  });
});

describe("buildExperimentProposalInput — parameter family mapping", () => {
  it("24. LOW_CONFIDENCE → confidence_threshold", () => {
    const p = buildExperimentProposalInput(makeRec({ reason_code: "LOW_CONFIDENCE" }));
    expect(p.parameter).toBe("confidence_threshold");
  });

  it("25. LOW_SETUP_SCORE → setup_score_threshold", () => {
    const p = buildExperimentProposalInput(makeRec({ reason_code: "LOW_SETUP_SCORE" }));
    expect(p.parameter).toBe("setup_score_threshold");
  });

  it("26. COACH_PENALTY → coach_penalty", () => {
    const p = buildExperimentProposalInput(makeRec({
      reason_code: "COACH_PENALTY",
      recommendation_type: "QUESTION_BLOCKER",
    }));
    expect(p.parameter).toBe("coach_penalty");
  });

  it("27. RISK_MANAGER_VETO → risk_manager_veto", () => {
    const p = buildExperimentProposalInput(makeRec({
      reason_code: "RISK_MANAGER_VETO",
      recommendation_type: "QUESTION_BLOCKER",
    }));
    expect(p.parameter).toBe("risk_manager_veto");
  });

  it("28. Unknown reason_code → strategy_fit", () => {
    const p = buildExperimentProposalInput(makeRec({ reason_code: "UNKNOWN_CODE" }));
    expect(p.parameter).toBe("strategy_fit");
  });
});

describe("buildExperimentProposalInput — hypothesis and notes", () => {
  const rec = makeRec();
  const proposal = buildExperimentProposalInput(rec);

  it("29. hypothesis includes the recommendation text", () => {
    expect(proposal.hypothesis).toContain(rec.recommendation);
  });

  it("30. hypothesis includes the reason_code", () => {
    expect(proposal.hypothesis).toContain(rec.reason_code);
  });

  it("31. notes state this is research-only", () => {
    expect(proposal.notes).toContain("research-only");
  });

  it("34. notes contain safety copy about not changing strategies", () => {
    expect(proposal.notes.toLowerCase()).toContain("does not change");
  });
});

// ─── Exported constants ───────────────────────────────────────────────────────

describe("SAFETY_BLOCK_REASON_CODES", () => {
  it("36. contains all seven safety codes", () => {
    const expected = [
      "KILL_SWITCH_ACTIVE",
      "DAILY_LOSS_CAP_REACHED",
      "ACCOUNT_FLOOR_BREACHED",
      "MAX_TRADES_REACHED",
      "COOLDOWN_ACTIVE",
      "DOCTRINE_BLOCK",
      "RISK_GATE_BLOCK",
    ];
    for (const code of expected) {
      expect(SAFETY_BLOCK_REASON_CODES.has(code)).toBe(true);
    }
  });
});

describe("EXPERIMENT_ELIGIBLE_TYPES", () => {
  it("37. contains exactly TUNE_THRESHOLD, QUESTION_BLOCKER, REVIEW_STRATEGY_FIT", () => {
    expect(EXPERIMENT_ELIGIBLE_TYPES.has("TUNE_THRESHOLD")).toBe(true);
    expect(EXPERIMENT_ELIGIBLE_TYPES.has("QUESTION_BLOCKER")).toBe(true);
    expect(EXPERIMENT_ELIGIBLE_TYPES.has("REVIEW_STRATEGY_FIT")).toBe(true);
    expect(EXPERIMENT_ELIGIBLE_TYPES.has("REINFORCE_BLOCKER")).toBe(false);
    expect(EXPERIMENT_ELIGIBLE_TYPES.has("INSUFFICIENT_EVIDENCE")).toBe(false);
  });
});

describe("reasonCodeToParameterFamily", () => {
  it("38. is deterministic — same input always produces same output", () => {
    const codes = ["LOW_CONFIDENCE", "LOW_SETUP_SCORE", "COACH_PENALTY", "RISK_MANAGER_VETO", "ANYTHING"];
    for (const code of codes) {
      expect(reasonCodeToParameterFamily(code)).toBe(reasonCodeToParameterFamily(code));
    }
  });
});

// ─── Eligibility interaction with type guard ──────────────────────────────────

describe("isExperimentEligible — integration with type gate", () => {
  it("35. safety reason_code blocks even when type is in eligible set", () => {
    // A TUNE_THRESHOLD with KILL_SWITCH_ACTIVE reason is still blocked
    expect(
      isExperimentEligible({
        recommendation_type: "TUNE_THRESHOLD",
        reason_code: "KILL_SWITCH_ACTIVE",
        status: "accepted",
      }),
    ).toBe(false);
    // A TUNE_THRESHOLD with LOW_CONFIDENCE reason is allowed
    expect(
      isExperimentEligible({
        recommendation_type: "TUNE_THRESHOLD",
        reason_code: "LOW_CONFIDENCE",
        status: "accepted",
      }),
    ).toBe(true);
  });
});
