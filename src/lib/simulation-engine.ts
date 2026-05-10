// ============================================================
// Simulation Engine — browser-side module
// ------------------------------------------------------------
// Pure scoring logic for the Batch Simulation Queue (PR #37).
// Converts decision_memory rows into scored simulation results.
//
// Safety rules enforced by this module:
//   - NEVER calls broker execution.
//   - NEVER inserts into trades or trade_signals.
//   - NEVER reads or modifies doctrine.
//   - NEVER approves signals.
//   - All functions are pure: same inputs → same outputs.
//   - No side effects, no network calls, no DOM access.
//
// Mirrors supabase/functions/_shared/simulation-engine.ts.
// Keep both in sync when changing types or scoring logic.
// ============================================================

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The two simulation types supported in this first version.
 *
 * TAKEN_IF_NOT_BLOCKED: "What would have happened if the signal had been
 *   allowed through?" Applied to learning-opportunity blocks (coach penalty,
 *   low confidence, risk manager veto, etc.). Scores setup quality and flags
 *   whether the signal had near-miss characteristics.
 *
 * SKIP_BASELINE: "Was skipping the right call?" Applied to all decision types.
 *   Confirms safety blocks. For learning opportunities, provides a baseline
 *   reference that the system can compare against future learning.
 */
export type SimulationType = "TAKEN_IF_NOT_BLOCKED" | "SKIP_BASELINE";

/**
 * Describes the outcome of a simulation.
 *
 * would_have_won / would_have_lost: Requires forward price data (not yet
 *   available at scoring time — reserved for PR #38 outcome enrichment).
 * no_clear_edge: Signal quality was below the near-miss threshold.
 * insufficient_data: Forward price data unavailable; setup quality scored only.
 * skipped: Confirms a skip was the modeled behavior (SKIP_BASELINE default).
 */
export type ResultLabel =
  | "would_have_won"
  | "would_have_lost"
  | "no_clear_edge"
  | "insufficient_data"
  | "skipped";

/**
 * Recommended action for the learning loop after reviewing the simulation.
 *
 * reinforce_block: Evidence supports the original block decision.
 * question_block: Near-miss quality; worth a human or Wendy review.
 * tune_threshold: Signal was near-threshold; consider adjusting the gate.
 * ignore_insufficient_data: Data/infra issue made the signal unscoreable.
 */
export type RecommendedLearningAction =
  | "reinforce_block"
  | "question_block"
  | "tune_threshold"
  | "ignore_insufficient_data";

/**
 * Non-sensitive snapshot of the decision_memory context used as simulation
 * input. Copied from the parent row at job creation time.
 *
 * Security: must never contain broker credentials, API keys, or auth headers.
 */
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

/**
 * Output of a single simulation run.
 *
 * Price fields (simulated_entry_price, simulated_exit_price, lookahead_window,
 * hypothetical_pnl, hypothetical_return_pct, max_adverse_excursion,
 * max_favorable_excursion) are ALL null in this version because forward
 * candle data at the exact decision timestamp is not yet available.
 * PR #38 (outcome enrichment) will patch these fields when historical
 * prices can be retrieved.
 *
 * Security: no broker credentials, order IDs, or execution fields.
 */
export interface SimulationResult {
  simulationType: SimulationType;

  /** Whether the simulation modeled an entry (i.e., signal cleared near-miss bar). */
  would_have_entered: boolean;

  // ── Price fields — reserved for PR #38 outcome enrichment ──────────────────
  // All null until forward candle data is available. Scored as insufficient_data.
  simulated_entry_price: null;
  simulated_exit_price: null;
  lookahead_window: null;
  hypothetical_pnl: null;
  hypothetical_return_pct: null;
  max_adverse_excursion: null;
  max_favorable_excursion: null;

  /** Outcome label — see ResultLabel JSDoc for meanings. */
  result_label: ResultLabel;

  /**
   * Signal quality score (0.0–1.0), geometric mean of setup_score × confidence.
   * Repurposed here as a proxy for "how good was this near-miss?" when
   * actual P&L cannot be computed (insufficient_data path).
   */
  confidence_after_result: number | null;

  /** What the learning loop should do with this simulation result. */
  recommended_learning_action: RecommendedLearningAction;

  /** Summary score (0.0–1.0) for easy sorting. Equals confidence_after_result. */
  score: number | null;

  /** ISO timestamp when this simulation was scored. */
  scored_at: string;
}

/**
 * A single row from the decision_memory_simulations table.
 */
export interface DecisionMemorySimulationRow {
  id: string;
  decision_memory_id: string;
  user_id: string;
  symbol: string | null;
  strategy_id: string | null;
  simulation_type: SimulationType;
  status: "queued" | "running" | "completed" | "failed";
  input_snapshot: SimulationInputSnapshot;
  result: SimulationResult | null;
  score: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ── Scoring constants ──────────────────────────────────────────────────────────

/** Minimum setup_score for TAKEN_IF_NOT_BLOCKED to model an entry. */
const MIN_SETUP_FOR_ENTRY = 0.55;

/** Minimum confidence for TAKEN_IF_NOT_BLOCKED to model an entry. */
const MIN_CONF_FOR_ENTRY = 0.42;

/** Setup threshold above which we consider a block worth questioning. */
const HIGH_SETUP_THRESHOLD = 0.65;

/**
 * Reason codes that represent correct safety blocks.
 * SKIP_BASELINE always reinforces these. TAKEN_IF_NOT_BLOCKED never applies.
 */
const SAFETY_BLOCK_CODES = new Set<string>([
  "KILL_SWITCH_ACTIVE",
  "DAILY_LOSS_CAP_REACHED",
  "ACCOUNT_FLOOR_BREACHED",
  "MAX_TRADES_REACHED",
  "COOLDOWN_ACTIVE",
  "DOCTRINE_BLOCK",
  "RISK_GATE_BLOCK",
]);

/**
 * Reason codes where data/infra issues made the signal unscoreable.
 * These should always get ignore_insufficient_data.
 */
const INFRA_ERROR_CODES = new Set<string>([
  "AI_ERROR",
  "BRAIN_TRUST_STALE",
  "MARKET_DATA_STALE",
  "RISK_MANAGER_SKIP_TICK",
  "NO_APPROVED_STRATEGY",
]);

// ── Pure helpers ───────────────────────────────────────────────────────────────

/** True if the reason code represents a hard safety gate (never improvable). */
export function isSafetyBlockCode(code: string): boolean {
  return SAFETY_BLOCK_CODES.has(code);
}

/** True if the reason code is due to data/infra issues (not signal quality). */
export function isInfraErrorCode(code: string): boolean {
  return INFRA_ERROR_CODES.has(code);
}

/**
 * Signal quality score: geometric mean of setup_score × confidence.
 * Returns null when both inputs are null (fully unscoreable).
 * Clamps to [0, 1].
 */
export function computeScore(
  setupScore: number | null,
  confidence: number | null,
): number | null {
  if (setupScore == null && confidence == null) return null;
  const s = Math.min(1, Math.max(0, setupScore ?? 0.5));
  const c = Math.min(1, Math.max(0, confidence ?? 0.5));
  return Math.sqrt(s * c);
}

/**
 * Determines what the learning loop should do after seeing this simulation.
 * Pure function — no side effects.
 */
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
      // High setup but coach multiplier knocked confidence below threshold.
      // Worth questioning if setup was genuinely strong.
      return setup >= HIGH_SETUP_THRESHOLD ? "question_block" : "reinforce_block";

    case "LOW_CONFIDENCE":
      // Near-threshold confidence with a decent setup suggests the confidence
      // gate may be slightly too strict for this regime.
      return setup >= 0.60 && conf >= 0.35 ? "tune_threshold" : "reinforce_block";

    case "RISK_MANAGER_VETO":
      // Human-like veto on a strong setup — worth a Wendy review.
      return setup >= HIGH_SETUP_THRESHOLD ? "question_block" : "reinforce_block";

    case "EDGE_BELOW_COSTS":
      // Edge barely below cost threshold with a decent setup.
      return setup >= 0.60 ? "tune_threshold" : "reinforce_block";

    case "OPERATOR_REJECTED":
      // Operator made a deliberate call — respect it.
      return "reinforce_block";

    default:
      return "reinforce_block";
  }
}

// ── Core simulation function ───────────────────────────────────────────────────

/**
 * Run one simulation against a decision_memory input snapshot.
 *
 * SAFETY CONTRACT:
 *   - No broker execution.
 *   - No trade row creation.
 *   - No doctrine reads or writes.
 *   - No signal approval.
 *   - Pure function: same inputs → same outputs (aside from scored_at timestamp).
 *
 * @param type    Which simulation scenario to model.
 * @param snapshot Non-sensitive decision context from decision_memory.
 * @returns       SimulationResult with price fields null (insufficient_data path).
 */
export function runSimulation(
  type: SimulationType,
  snapshot: SimulationInputSnapshot,
): SimulationResult {
  const scoredAt = new Date().toISOString();
  const { setupScore, confidence, reasonCode } = snapshot;
  const isSafety = isSafetyBlockCode(reasonCode);
  const score = computeScore(setupScore, confidence);

  if (type === "SKIP_BASELINE") {
    // SKIP_BASELINE models the path where the system skipped, as it did.
    // Safety blocks: always the right call.
    // Learning opportunities: may warrant questioning, but baseline records the skip.
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

  // TAKEN_IF_NOT_BLOCKED: model "what if the block had not fired?"
  // We score setup quality since forward price data is unavailable (PR #38).
  const setup = setupScore ?? 0;
  const conf = confidence ?? 0;
  const wouldHaveEntered =
    setup >= MIN_SETUP_FOR_ENTRY && conf >= MIN_CONF_FOR_ENTRY;

  const resultLabel: ResultLabel = wouldHaveEntered
    ? "insufficient_data" // Near-miss quality — can't determine P&L without prices
    : "no_clear_edge";    // Low quality — the block was clearly right

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

/**
 * Determine which simulation types should be created for a given reason code.
 *
 * Safety blocks → SKIP_BASELINE only (block was correct; no counterfactual).
 * Learning opportunities → TAKEN_IF_NOT_BLOCKED + SKIP_BASELINE.
 */
export function getSimulationTypesForReason(
  reasonCode: string,
): SimulationType[] {
  if (isSafetyBlockCode(reasonCode)) {
    return ["SKIP_BASELINE"];
  }
  return ["TAKEN_IF_NOT_BLOCKED", "SKIP_BASELINE"];
}

/**
 * Build a SimulationInputSnapshot from available decision_memory fields.
 * Safe to call for any decision_memory row.
 */
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
