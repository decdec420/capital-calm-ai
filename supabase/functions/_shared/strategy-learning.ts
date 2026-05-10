// ============================================================
// Strategy Learning Consumer — Deno _shared edition (PR #39)
// ------------------------------------------------------------
// Mirrors src/lib/strategy-learning.ts exactly.
// Kept in sync manually. Browser tests import from src/lib/.
// Edge functions import from here.
//
// Safety rules:
//   - NEVER auto-mutates strategies, params, or metrics.
//   - NEVER alters doctrine_settings or doctrine modes.
//   - NEVER approves, creates, or modifies signals or trades.
//   - NEVER calls any broker or execution endpoint.
//   - NEVER weakens safety blocks or risk gates.
//   - Safety blocks may ONLY generate REINFORCE_BLOCKER.
//   - All outputs are proposal-only.
// ============================================================

import type { LearningAction, SimulationResult } from "./outcome-enrichment.ts";

export type RecommendationType =
  | "REINFORCE_BLOCKER"
  | "QUESTION_BLOCKER"
  | "TUNE_THRESHOLD"
  | "REVIEW_STRATEGY_FIT"
  | "INSUFFICIENT_EVIDENCE";

export type SampleQuality = "insufficient" | "weak" | "moderate" | "strong";

export type RecommendationStatus = "pending_review" | "accepted" | "rejected" | "deferred";

export const MIN_EVIDENCE_COUNT = 5;
export const STRONG_EVIDENCE_COUNT = 20;
export const MIN_ACTIONABLE_CONFIDENCE = 0.65;

const SAFETY_BLOCK_CODES = new Set([
  "KILL_SWITCH_ACTIVE",
  "DAILY_LOSS_CAP_REACHED",
  "ACCOUNT_FLOOR_BREACHED",
  "MAX_TRADES_REACHED",
  "COOLDOWN_ACTIVE",
  "DOCTRINE_BLOCK",
  "RISK_GATE_BLOCK",
]);

export function hasSafetyBlock(blockerCodes: string[]): boolean {
  return blockerCodes.some((c) => SAFETY_BLOCK_CODES.has(c));
}

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

export interface EvidenceGroupKey {
  user_id: string;
  symbol: string | null;
  strategy_id: string | null;
  market_regime: string | null;
  reason_code: string;
  recommended_learning_action: LearningAction;
  blocker_codes?: string[];
}

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

export interface EvidenceGroup {
  key: EvidenceGroupKey;
  rows: EvidenceRow[];
  wouldHaveWon: number;
  wouldHaveLost: number;
  totalActionable: number;
}

export function groupEvidence(rows: EvidenceRow[]): EvidenceGroup[] {
  const map = new Map<string, EvidenceGroup>();

  for (const row of rows) {
    const result = row.result;

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
      blocker_codes: row.blocker_codes,
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

export function scoreSampleQuality(count: number): SampleQuality {
  if (count < MIN_EVIDENCE_COUNT) return "insufficient";
  if (count < 10) return "weak";
  if (count < STRONG_EVIDENCE_COUNT) return "moderate";
  return "strong";
}

export function scoreConfidence(group: EvidenceGroup): number {
  const total = group.totalActionable;
  if (total === 0) return 0;

  const action = group.key.recommended_learning_action;
  const favorable =
    action === "reinforce_block" ? group.wouldHaveLost : group.wouldHaveWon;

  const smoothed = (favorable + 1) / (total + 2);
  const sizeDiscount = Math.min(1, total / STRONG_EVIDENCE_COUNT);
  return Math.round(smoothed * sizeDiscount * 1000) / 1000;
}

export function buildRecommendationText(
  group: EvidenceGroup,
  type: RecommendationType,
): string {
  const { reason_code, symbol, market_regime } = group.key;
  const count = group.totalActionable;
  const won = group.wouldHaveWon;
  const lost = group.wouldHaveLost;
  const scope = [symbol, market_regime].filter(Boolean).join(" / ") || "all symbols";
  const blockers = group.key.blocker_codes ?? [reason_code];

  switch (type) {
    case "REINFORCE_BLOCKER":
      if (hasSafetyBlock(blockers)) {
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

export function classifyGroup(group: EvidenceGroup): RecommendationType {
  const action = group.key.recommended_learning_action;
  const blockers = group.key.blocker_codes ?? [group.key.reason_code];

  if (hasSafetyBlock(blockers)) {
    return "REINFORCE_BLOCKER";
  }

  if (group.totalActionable < MIN_EVIDENCE_COUNT) {
    return "INSUFFICIENT_EVIDENCE";
  }

  const confidence = scoreConfidence(group);

  switch (action) {
    case "reinforce_block":
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

export function buildAllRecommendations(
  groups: EvidenceGroup[],
): StrategyLearningRecommendation[] {
  return groups.map((g) => buildRecommendation(g));
}
