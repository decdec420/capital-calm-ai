// ============================================================
// Simulation Engine — _shared edition (Deno-compatible)
// ------------------------------------------------------------
// Pure scoring logic for the Batch Simulation Queue (PR #37).
// Mirrors src/lib/simulation-engine.ts — kept in sync manually.
//
// Safety invariants enforced by this module:
//   - NEVER calls broker execution.
//   - NEVER inserts into trades or trade_signals.
//   - NEVER reads or modifies doctrine.
//   - NEVER approves or rejects signals.
//   - All functions are pure: same inputs → same outputs.
//   - No network calls, no Deno I/O.
//   - No imports from execution modules (signal-decide, jessica, katrina, etc.)
// ============================================================

export type SimulationType = "TAKEN_IF_NOT_BLOCKED" | "SKIP_BASELINE";

export type ResultLabel =
  | "would_have_won"
  | "would_have_lost"
  | "no_clear_edge"
  | "insufficient_data"
  | "skipped";

export type RecommendedLearningAction =
  | "reinforce_block"
  | "question_block"
  | "tune_threshold"
  | "ignore_insufficient_data";

export interface SimulationInputSnapshot {
  symbol: string | null;
  regime: string | null;
  setupScore: number | null;
  confidence: number | null;
  reasonCode: string;
  severity: string;
  blockerCodes: string[];
  mode: string;
  createdAt: string;
}

export interface SimulationResult {
  simulationType: SimulationType;
  would_have_entered: boolean;
  simulated_entry_price: null;
  simulated_exit_price: null;
  lookahead_window: null;
  hypothetical_pnl: null;
  hypothetical_return_pct: null;
  max_adverse_excursion: null;
  max_favorable_excursion: null;
  result_label: ResultLabel;
  confidence_after_result: number | null;
  recommended_learning_action: RecommendedLearningAction;
  score: number | null;
  scored_at: string;
}

// ── Scoring constants ──────────────────────────────────────────────────────────

const MIN_SETUP_FOR_ENTRY = 0.55;
const MIN_CONF_FOR_ENTRY = 0.42;
const HIGH_SETUP_THRESHOLD = 0.65;

const SAFETY_BLOCK_CODES = new Set<string>([
  "KILL_SWITCH_ACTIVE",
  "DAILY_LOSS_CAP_REACHED",
  "ACCOUNT_FLOOR_BREACHED",
  "MAX_TRADES_REACHED",
  "COOLDOWN_ACTIVE",
  "DOCTRINE_BLOCK",
  "RISK_GATE_BLOCK",
]);

const INFRA_ERROR_CODES = new Set<string>([
  "AI_ERROR",
  "BRAIN_TRUST_STALE",
  "MARKET_DATA_STALE",
  "RISK_MANAGER_SKIP_TICK",
  "NO_APPROVED_STRATEGY",
]);

// ── Pure helpers ───────────────────────────────────────────────────────────────

export function isSafetyBlockCode(code: string): boolean {
  return SAFETY_BLOCK_CODES.has(code);
}

export function isInfraErrorCode(code: string): boolean {
  return INFRA_ERROR_CODES.has(code);
}

export function computeScore(
  setupScore: number | null,
  confidence: number | null,
): number | null {
  if (setupScore == null && confidence == null) return null;
  const s = Math.min(1, Math.max(0, setupScore ?? 0.5));
  const c = Math.min(1, Math.max(0, confidence ?? 0.5));
  return Math.sqrt(s * c);
}

export function getRecommendedAction(
  reasonCode: string,
  setupScore: number | null,
  confidence: number | null,
): RecommendedLearningAction {
  if (isSafetyBlockCode(reasonCode)) return "reinforce_block";
  if (isInfraErrorCode(reasonCode)) return "ignore_insufficient_data";

  const setup = setupScore ?? 0;
  const conf = confidence ?? 0;

  switch (reasonCode) {
    case "COACH_PENALTY":
      return setup >= HIGH_SETUP_THRESHOLD ? "question_block" : "reinforce_block";

    case "LOW_CONFIDENCE":
      return setup >= 0.60 && conf >= 0.35 ? "tune_threshold" : "reinforce_block";

    case "RISK_MANAGER_VETO":
      return setup >= HIGH_SETUP_THRESHOLD ? "question_block" : "reinforce_block";

    case "EDGE_BELOW_COSTS":
      return setup >= 0.60 ? "tune_threshold" : "reinforce_block";

    case "OPERATOR_REJECTED":
      return "reinforce_block";

    default:
      return "reinforce_block";
  }
}

export function runSimulation(
  type: SimulationType,
  snapshot: SimulationInputSnapshot,
): SimulationResult {
  const scoredAt = new Date().toISOString();
  const { setupScore, confidence, reasonCode } = snapshot;
  const isSafety = isSafetyBlockCode(reasonCode);
  const score = computeScore(setupScore, confidence);

  if (type === "SKIP_BASELINE") {
    const action: RecommendedLearningAction = isSafety
      ? "reinforce_block"
      : getRecommendedAction(reasonCode, setupScore, confidence);

    return {
      simulationType: "SKIP_BASELINE",
      would_have_entered: false,
      simulated_entry_price: null,
      simulated_exit_price: null,
      lookahead_window: null,
      hypothetical_pnl: null,
      hypothetical_return_pct: null,
      max_adverse_excursion: null,
      max_favorable_excursion: null,
      result_label: "skipped",
      confidence_after_result: score,
      recommended_learning_action: action,
      score,
      scored_at: scoredAt,
    };
  }

  // TAKEN_IF_NOT_BLOCKED
  const setup = setupScore ?? 0;
  const conf = confidence ?? 0;
  const wouldHaveEntered =
    setup >= MIN_SETUP_FOR_ENTRY && conf >= MIN_CONF_FOR_ENTRY;

  const resultLabel: ResultLabel = wouldHaveEntered
    ? "insufficient_data"
    : "no_clear_edge";

  const action = getRecommendedAction(reasonCode, setupScore, confidence);

  return {
    simulationType: "TAKEN_IF_NOT_BLOCKED",
    would_have_entered: wouldHaveEntered,
    simulated_entry_price: null,
    simulated_exit_price: null,
    lookahead_window: null,
    hypothetical_pnl: null,
    hypothetical_return_pct: null,
    max_adverse_excursion: null,
    max_favorable_excursion: null,
    result_label: resultLabel,
    confidence_after_result: score,
    recommended_learning_action: action,
    score,
    scored_at: scoredAt,
  };
}

export function getSimulationTypesForReason(
  reasonCode: string,
): SimulationType[] {
  if (isSafetyBlockCode(reasonCode)) {
    return ["SKIP_BASELINE"];
  }
  return ["TAKEN_IF_NOT_BLOCKED", "SKIP_BASELINE"];
}

export function buildInputSnapshot(params: {
  symbol: string | null;
  regime: string | null;
  setupScore: number | null;
  confidence: number | null;
  reasonCode: string;
  severity: string;
  blockerCodes: string[];
  mode: string;
  createdAt: string;
}): SimulationInputSnapshot {
  return {
    symbol: params.symbol,
    regime: params.regime,
    setupScore: params.setupScore,
    confidence: params.confidence,
    reasonCode: params.reasonCode,
    severity: params.severity,
    blockerCodes: params.blockerCodes,
    mode: params.mode,
    createdAt: params.createdAt,
  };
}
