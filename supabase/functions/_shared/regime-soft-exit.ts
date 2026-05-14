// ============================================================
// Regime-change soft-exit simulation prep
// ------------------------------------------------------------
// Pure modeling only. This module never reads/writes the DB, never calls a
// broker, never closes positions, and never mutates doctrine or strategies.
// PR #54 can use this shape to enqueue/store dry-run simulations.
// ============================================================

export type RegimeSoftExitSide = "long" | "short";
export type RegimeSoftExitAction =
  | "NO_ACTION"
  | "TIGHTEN_STOP"
  | "REDUCE_POSITION_25"
  | "REDUCE_POSITION_50"
  | "FULL_EXIT_SIMULATION_ONLY";
export type RegimeSoftExitSeverity = "info" | "warning" | "critical";

export type RegimeSoftExitInput = {
  side: RegimeSoftExitSide | string | null | undefined;
  entryRegime: string | null | undefined;
  currentRegime: string | null | undefined;
  unrealizedPnl?: number | null;
  atr?: number | null;
  volatility?: string | null;
  timeInTradeMinutes?: number | null;
  currentStopDistancePct?: number | null;
  confidence?: number | null;
  strategyEvidenceScore?: number | null;
};

export type RegimeSoftExitSimulation = {
  shouldSimulate: boolean;
  reasonCodes: string[];
  simulatedActions: RegimeSoftExitAction[];
  severity: RegimeSoftExitSeverity;
  executionAllowed: false;
};

export type RegimeSoftExitDecisionMemoryShape = {
  simulationType: "regime_change_soft_exit";
  reasonCode: "REGIME_CHANGE_SOFT_EXIT_SIMULATION";
  inputSnapshot: RegimeSoftExitInput;
  result: RegimeSoftExitSimulation;
  executionAllowed: false;
};

const UNKNOWN_REGIMES = new Set(["", "unknown", "no_trade", "insufficient_data"]);
const RANGE_OR_CHOP_REGIMES = new Set(["range", "chop"]);

function normalizeSide(side: RegimeSoftExitInput["side"]): RegimeSoftExitSide | null {
  return side === "long" || side === "short" ? side : null;
}

function normalizeRegime(regime: string | null | undefined): string | null {
  if (typeof regime !== "string") return null;
  const normalized = regime.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function noAction(reasonCodes: string[], severity: RegimeSoftExitSeverity = "info"): RegimeSoftExitSimulation {
  return {
    shouldSimulate: false,
    reasonCodes,
    simulatedActions: ["NO_ACTION"],
    severity,
    executionAllowed: false,
  };
}

export function evaluateRegimeSoftExit(input: RegimeSoftExitInput): RegimeSoftExitSimulation {
  const side = normalizeSide(input.side);
  if (!side) {
    return noAction(["MISSING_POSITION_SIDE", "DEFAULT_LONG_FALLBACK_BLOCKED"], "warning");
  }

  const entryRegime = normalizeRegime(input.entryRegime);
  const currentRegime = normalizeRegime(input.currentRegime);
  if (!entryRegime || !currentRegime || UNKNOWN_REGIMES.has(entryRegime) || UNKNOWN_REGIMES.has(currentRegime)) {
    return noAction(["REGIME_UNKNOWN", "SIMULATION_ONLY"], "info");
  }

  if (RANGE_OR_CHOP_REGIMES.has(entryRegime) && RANGE_OR_CHOP_REGIMES.has(currentRegime)) {
    return noAction(["RANGE_CHOP_UNCHANGED", "SIMULATION_ONLY"], "info");
  }

  const longAdverseFlip = side === "long" && entryRegime === "trending_up" && currentRegime === "trending_down";
  const shortAdverseFlip = side === "short" && entryRegime === "trending_down" && currentRegime === "trending_up";

  if (longAdverseFlip || shortAdverseFlip) {
    const reasonCodes = [
      "REGIME_CHANGE_AGAINST_POSITION",
      side === "long" ? "LONG_TRENDING_UP_TO_DOWN" : "SHORT_TRENDING_DOWN_TO_UP",
      "SOFT_EXIT_SIMULATION_ONLY",
    ];

    if (typeof input.unrealizedPnl === "number" && input.unrealizedPnl < 0) {
      reasonCodes.push("UNREALIZED_LOSS_PRESENT");
    }
    if (input.volatility === "extreme" || input.volatility === "elevated") {
      reasonCodes.push("VOLATILITY_ELEVATED");
    }

    return {
      shouldSimulate: true,
      reasonCodes,
      simulatedActions: ["TIGHTEN_STOP", "REDUCE_POSITION_50"],
      severity: input.volatility === "extreme" ? "critical" : "warning",
      executionAllowed: false,
    };
  }

  if (RANGE_OR_CHOP_REGIMES.has(currentRegime)) {
    return noAction(["CURRENT_REGIME_RANGE_OR_CHOP", "SIMULATION_ONLY"], "info");
  }

  return noAction(["NO_ADVERSE_REGIME_FLIP", "SIMULATION_ONLY"], "info");
}

export function buildRegimeSoftExitDecisionMemoryShape(
  input: RegimeSoftExitInput,
): RegimeSoftExitDecisionMemoryShape {
  return {
    simulationType: "regime_change_soft_exit",
    reasonCode: "REGIME_CHANGE_SOFT_EXIT_SIMULATION",
    inputSnapshot: { ...input },
    result: evaluateRegimeSoftExit(input),
    executionAllowed: false,
  };
}
