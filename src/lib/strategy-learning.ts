// ============================================================
// Strategy Learning Consumer — PR #39 (Proposal-Only)
// ------------------------------------------------------------
// Reads enriched decision_memory_simulations and groups evidence
// into reviewable strategy learning recommendations.
//
// Safety rules enforced by this module:
//   - NEVER auto-mutates strategies, params, or metrics.
//   - NEVER alters doctrine_settings or doctrine modes.
//   - NEVER approves, creates, or modifies signals or trades.
//   - NEVER calls any broker or execution endpoint.
//   - NEVER weakens safety blocks or risk gates.
//   - Safety blocks may ONLY generate REINFORCE_BLOCKER.
//   - Safety blocks must NEVER generate QUESTION_BLOCKER or TUNE_THRESHOLD.
//   - Recommendations with insufficient evidence stay INSUFFICIENT_EVIDENCE.
//   - All outputs are proposal-only: require human review before any action.
// ============================================================

import type { LearningAction, SimulationResult } from "./outcome-enrichment";

// ─── Recommendation types ─────────────────────────────────────────────────────

/**
 * What the consumer recommends a human reviewer do.
 *
 * Safety: REINFORCE_BLOCKER is the only recommendation allowed for
 * safety block codes (kill switch, daily cap, floor, etc.).
 */
export type RecommendationType =
  | "REINFORCE_BLOCKER"    // Evidence confirms this block is correct; keep it
  | "QUESTION_BLOCKER"     // Evidence suggests this block may deserve review
  | "TUNE_THRESHOLD"       // Threshold-based block shows consistent missed wins
  | "REVIEW_STRATEGY_FIT"  // Symbol+regime+strategy combo needs attention
  | "INSUFFICIENT_EVIDENCE"; // Pattern noticed but sample too small to act on

export type SampleQuality = "insufficient" | "weak" | "moderate" | "strong";

export type RecommendationStatus = "pending_review" | "accepted" | "rejected" | "deferred";

// ─── Evidence thresholds ──────────────────────────────────────────────────────

/** Minimum simulations required before any recommendation is generated. */
export const MIN_EVIDENCE_COUNT = 5;

/** Evidence count for strong classification. */
export const STRONG_EVIDENCE_COUNT = 20;

/**
 * Minimum win-rate for actionable recommendations (QUESTION_BLOCKER / TUNE_THRESHOLD).
 * Conservative: 65% of blocked signals must have been favorable to suggest review.
 */
export const MIN_ACTIONABLE_CONFIDENCE = 0.65;

// ─── Safety block codes (mirrored from outcome-enrichment.ts) ────────────────

const SAFETY_BLOCK_CODES = new Set([
  "KILL_SWITCH_ACTIVE",
  "DAILY_LOSS_CAP_REACHED",
  "ACCOUNT_FLOOR_BREACHED",
  "MAX_TRADES_REACHED",
  "COOLDOWN_ACTIVE",
  "DOCTRINE_BLOCK",
  "RISK_GATE_BLOCK",
]);

/** Returns true if any code in the array is a structural safety block. */
export function hasSafetyBlock(blockerCodes: string[]): boolean {
  return blockerCodes.some((c) => SAFETY_BLOCK_CODES.has(c));
}

// ─── Evidence row (input to consumer) ────────────────────────────────────────

/** One enriched simulation row, projected to what the consumer needs. */
export interface EvidenceRow {
  id: string;
  user_id: string;
  decision_memory_id: string;
  symbol: string | null;
  strategy_id: string | null;
  market_regime: string | null;
  reason_code: string;
  blocker_codes: string[];
  result: SimulationResult;
}

// ─── Grouping key ─────────────────────────────────────────────────────────────

/** Canonical key used to group evidence rows into recommendation buckets. */
export interface EvidenceGroupKey {
  user_id: string;
  symbol: string | null;
  strategy_id: string | null;
  market_regime: string | null;
  reason_code: string;
  recommended_learning_action: LearningAction;
}

/** Stringify a group key for use as a Map key. */
export function groupKeyString(k: EvidenceGroupKey): string {
  return [
    k.user_id,
    k.symbol ?? "_",
    k.strategy_id ?? "_",
    k.market_regime ?? "_",
    k.reason_code,
    k.recommended_learning_action,
  ].join("|");
}

// ─── Evidence group ───────────────────────────────────────────────────────────

export interface EvidenceGroup {
  key: EvidenceGroupKey;
  rows: EvidenceRow[];
  wouldHaveWon: number;
  wouldHaveLost: number;
  totalActionable: number;
}

/**
 * Group usable evidence rows by (user, symbol, strategy, regime, reason, action).
 *
 * Filters out:
 *   - insufficient_data results
 *   - no_clear_edge results
 *   - ignore_insufficient_data actions
 */
export function groupEvidence(rows: EvidenceRow[]): EvidenceGroup[] {
  const map = new Map<string, EvidenceGroup>();

  for (const row of rows) {
    const result = row.result;

    // Skip non-actionable outcomes
    if (
      result.result_label === "insufficient_data" ||
      result.result_label === "no_clear_edge" ||
      result.recommended_learning_action === "ignore_insufficient_data"
    ) {
      continue;
    }

    const key: EvidenceGroupKey = {
      user_id: row.user_id,
      symbol: row.symbol,
      strategy_id: row.strategy_id,
      market_regime: row.market_regime,
      reason_code: row.reason_code,
      recommended_learning_action: result.recommended_learning_action,
    };

    const ks = groupKeyString(key);
    let group = map.get(ks);
    if (!group) {
      group = { key, rows: [], wouldHaveWon: 0, wouldHaveLost: 0, totalActionable: 0 };
      map.set(ks, group);
    }

    group.rows.push(row);
    group.totalActionable++;
    if (result.result_label === "would_have_won") group.wouldHaveWon++;
    else if (result.result_label === "would_have_lost") group.wouldHaveLost++;
  }

  return Array.from(map.values());
}

// ─── Sample quality ───────────────────────────────────────────────────────────

export function scoreSampleQuality(count: number): SampleQuality {
  if (count < MIN_EVIDENCE_COUNT) return "insufficient";
  if (count < 10) return "weak";
  if (count < STRONG_EVIDENCE_COUNT) return "moderate";
  return "strong";
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

/**
 * Compute conservative confidence for a group.
 *
 * For REINFORCE_BLOCKER: fraction of would_have_lost out of actionable.
 * For QUESTION_BLOCKER / TUNE_THRESHOLD: fraction of would_have_won out of actionable.
 *
 * Applies a Laplace smoothing of 1 to avoid extreme values with tiny samples.
 * Conservative: requires at least MIN_EVIDENCE_COUNT to exceed floor.
 */
export function scoreConfidence(group: EvidenceGroup): number {
  const total = group.totalActionable;
  if (total === 0) return 0;

  const action = group.key.recommended_learning_action;
  const favorable =
    action === "reinforce_block" ? group.wouldHaveLost : group.wouldHaveWon;

  // Laplace smoothing: (favorable + 1) / (total + 2)
  const smoothed = (favorable + 1) / (total + 2);

  // Apply a sample-size discount for small samples
  const sizeDiscount = Math.min(1, total / STRONG_EVIDENCE_COUNT);
  return Math.round(smoothed * sizeDiscount * 1000) / 1000;
}

// ─── Recommendation text generation ──────────────────────────────────────────

/**
 * Generate a human-readable recommendation text.
 *
 * Safety: safety blocks always produce REINFORCE_BLOCKER text regardless of
 * what the market did after the block. The text acknowledges the price move
 * but affirms the block's correctness.
 */
export function buildRecommendationText(
  group: EvidenceGroup,
  type: RecommendationType,
): string {
  const { reason_code, symbol, market_regime } = group.key;
  const count = group.totalActionable;
  const won = group.wouldHaveWon;
  const lost = group.wouldHaveLost;
  const scope = [symbol, market_regime].filter(Boolean).join(" / ") || "all symbols";

  switch (type) {
    case "REINFORCE_BLOCKER":
      if (hasSafetyBlock(group.key.blocker_codes ?? [reason_code])) {
        return (
          `Safety block ${reason_code} on ${scope} correctly prevented ${lost}/${count} ` +
          `losing scenarios. ${won > 0 ? `${won} favorable moves occurred after the block — ` : ""}` +
          `safety invariant was met regardless of subsequent price action. Reinforce this gate.`
        );
      }
      return (
        `Block ${reason_code} on ${scope} was correct in ${lost}/${count} cases. ` +
        `Evidence supports keeping this block. No threshold change needed.`
      );

    case "QUESTION_BLOCKER":
      return (
        `Review ${reason_code} block criteria for ${scope}: ${won}/${count} blocked signals ` +
        `later moved favorably. Consider whether the block threshold is correctly calibrated.`
      );

    case "TUNE_THRESHOLD":
      return (
        `Review confidence threshold for ${scope}: ${won}/${count} signals blocked by ` +
        `${reason_code} later moved favorably. The threshold may be set too conservatively ` +
        `for this symbol/regime combination.`
      );

    case "REVIEW_STRATEGY_FIT":
      return (
        `Strategy fit review for ${scope}: mixed outcomes (${won} favorable / ${lost} adverse) ` +
        `across ${count} ${reason_code} blocks. This symbol+regime combination may need ` +
        `strategy parameter review.`
      );

    case "INSUFFICIENT_EVIDENCE":
      return (
        `Insufficient evidence for ${reason_code} on ${scope}: only ${count} sample(s) available ` +
        `(minimum ${MIN_EVIDENCE_COUNT} required for actionable recommendation). ` +
        `Recheck when more data accumulates.`
      );
  }
}

// ─── Core classifier ──────────────────────────────────────────────────────────

/**
 * Classify a single evidence group into a RecommendationType.
 *
 * Safety rules (enforced here, not just in enrichment):
 *   1. Safety blocks → REINFORCE_BLOCKER only, regardless of win rate.
 *   2. Insufficient sample size → INSUFFICIENT_EVIDENCE.
 *   3. Confidence below threshold → INSUFFICIENT_EVIDENCE.
 *   4. reinforce_block action → REINFORCE_BLOCKER.
 *   5. question_block action → QUESTION_BLOCKER (non-safety only).
 *   6. tune_threshold action + reason_code = LOW_CONFIDENCE → TUNE_THRESHOLD.
 *   7. Mixed signals across groups → REVIEW_STRATEGY_FIT.
 */
export function classifyGroup(group: EvidenceGroup): RecommendationType {
  const action = group.key.recommended_learning_action;
  const blockers = group.key.blocker_codes ?? [group.key.reason_code];

  // Safety blocks → always REINFORCE_BLOCKER
  if (hasSafetyBlock(blockers)) {
    return "REINFORCE_BLOCKER";
  }

  // Insufficient sample size
  if (group.totalActionable < MIN_EVIDENCE_COUNT) {
    return "INSUFFICIENT_EVIDENCE";
  }

  const confidence = scoreConfidence(group);

  switch (action) {
    case "reinforce_block":
      // Even if confidence is low, still recommend reinforcement
      return "REINFORCE_BLOCKER";

    case "question_block":
      if (confidence < MIN_ACTIONABLE_CONFIDENCE) return "INSUFFICIENT_EVIDENCE";
      return "QUESTION_BLOCKER";

    case "tune_threshold":
      if (confidence < MIN_ACTIONABLE_CONFIDENCE) return "INSUFFICIENT_EVIDENCE";
      return "TUNE_THRESHOLD";

    case "ignore_insufficient_data":
      return "INSUFFICIENT_EVIDENCE";
  }
}

// ─── Recommendation record (output shape) ────────────────────────────────────

/** Shape of a row to be inserted into strategy_learning_recommendations. */
export interface StrategyLearningRecommendation {
  user_id: string;
  symbol: string | null;
  strategy_id: string | null;
  market_regime: string | null;
  reason_code: string;
  recommendation_type: RecommendationType;
  recommendation: string;
  confidence: number;
  evidence_count: number;
  sample_quality: SampleQuality;
  supporting_simulation_ids: string[];
  status: RecommendationStatus;
}

/**
 * Convert a single evidence group into a recommendation record.
 *
 * Does NOT write to the database — returns the record for the caller to insert.
 * This keeps the pure logic testable without a DB connection.
 */
export function buildRecommendation(group: EvidenceGroup): StrategyLearningRecommendation {
  const type = classifyGroup(group);
  const confidence = scoreConfidence(group);
  const quality = scoreSampleQuality(group.totalActionable);

  return {
    user_id: group.key.user_id,
    symbol: group.key.symbol,
    strategy_id: group.key.strategy_id,
    market_regime: group.key.market_regime,
    reason_code: group.key.reason_code,
    recommendation_type: type,
    recommendation: buildRecommendationText(group, type),
    confidence,
    evidence_count: group.totalActionable,
    sample_quality: quality,
    supporting_simulation_ids: group.rows.map((r) => r.id),
    status: "pending_review",
  };
}

/**
 * Convert all evidence groups into recommendation records.
 *
 * Returns all groups, including INSUFFICIENT_EVIDENCE ones, so the caller
 * can mark their simulations as consumed and avoid re-processing them.
 */
export function buildAllRecommendations(
  groups: EvidenceGroup[],
): StrategyLearningRecommendation[] {
  return groups.map((g) => buildRecommendation(g));
}
