// ============================================================
// Regime soft-exit learning aggregation (review-only)
// ------------------------------------------------------------
// Pure helper for grouping REGIME_CHANGE_SOFT_EXIT simulation artifacts into
// operator learning summaries. This module has no storage adapter, imports no
// broker/execution code, and never mutates trades, stops, take-profits,
// doctrine, strategies, signals, or orders.
// ============================================================

export type SoftExitSide = "long" | "short";
export type SoftExitSeverity = "info" | "warning" | "critical";
export type SoftExitReviewStatus = "unreviewed" | "acknowledged" | "reviewed" | "dismissed";
export type SoftExitOutcomeUsefulness = "useful" | "not_useful" | "mixed" | "unknown";
export type SoftExitSampleQuality = "insufficient" | "emerging" | "strong";
export type SoftExitRecommendationType =
  | "KEEP_OBSERVING"
  | "REVIEW_PATTERN"
  | "CONSIDER_EXPERIMENT_PROPOSAL";

export interface SoftExitLearningSummary {
  groupKey: string;
  symbol: string | null;
  side: SoftExitSide | null;
  entryRegime: string | null;
  currentRegime: string | null;
  simulatedActions: string[];
  severity: SoftExitSeverity;
  totalCount: number;
  acknowledgedCount: number;
  reviewedCount: number;
  dismissedCount: number;
  unreviewedCount: number;
  usefulCount?: number;
  notUsefulCount?: number;
  sampleQuality: SoftExitSampleQuality;
  recommendationType: SoftExitRecommendationType;
  recommendation: string;
  executionAllowed: false;
}

export interface SoftExitLearningSimulationRow {
  id?: string;
  status?: string | null;
  symbol?: string | null;
  input_snapshot?: unknown;
  result?: unknown;
  review_status?: string | null;
}

interface NormalizedSoftExitSimulation {
  symbol: string | null;
  side: SoftExitSide | null;
  entryRegime: string | null;
  currentRegime: string | null;
  simulatedActions: string[];
  severity: SoftExitSeverity;
  resultLabel: string | null;
  reviewStatus: SoftExitReviewStatus;
  usefulness: SoftExitOutcomeUsefulness;
}

export const SOFT_EXIT_EMERGING_SAMPLE_COUNT = 5;
export const SOFT_EXIT_STRONG_SAMPLE_COUNT = 12;
export const SOFT_EXIT_STRONG_REVIEWED_COUNT = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeSide(value: unknown): SoftExitSide | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "long" || text === "buy") return "long";
  if (text === "short" || text === "sell") return "short";
  return null;
}

function normalizeSeverity(value: unknown): SoftExitSeverity {
  return value === "critical" || value === "warning" || value === "info" ? value : "info";
}

function normalizeReviewStatus(value: unknown): SoftExitReviewStatus {
  return value === "acknowledged" || value === "reviewed" || value === "dismissed" || value === "unreviewed"
    ? value
    : "unreviewed";
}

function normalizeActions(value: unknown): string[] {
  if (Array.isArray(value)) {
    const actions = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
    return actions.length > 0 ? [...new Set(actions)].sort() : ["NO_ACTION"];
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return ["NO_ACTION"];
}

function readOutcomeEvidence(result: Record<string, unknown>, input: Record<string, unknown>): SoftExitOutcomeUsefulness {
  const evidence = isRecord(result.outcome_evidence)
    ? result.outcome_evidence
    : isRecord(result.soft_exit_outcome_evidence)
      ? result.soft_exit_outcome_evidence
      : isRecord(input.outcome_evidence)
        ? input.outcome_evidence
        : null;

  if (typeof evidence?.would_have_helped === "boolean") {
    return evidence.would_have_helped ? "useful" : "not_useful";
  }

  const explicit = readString(
    evidence?.usefulness,
    evidence?.would_have_helped,
    evidence?.label,
    result.usefulness,
    result.soft_exit_usefulness,
    result.outcome_usefulness,
    result.eventual_outcome_usefulness,
  )?.toLowerCase();

  if (explicit) {
    if (["useful", "helpful", "would_have_helped", "helped", "true"].includes(explicit)) return "useful";
    if (["not_useful", "not useful", "unhelpful", "would_not_have_helped", "false"].includes(explicit)) return "not_useful";
    if (["mixed", "unclear"].includes(explicit)) return "mixed";
    if (["unknown", "outcome_pending", "insufficient_data"].includes(explicit)) return "unknown";
  }

  const outcomeLabel = readString(
    evidence?.outcome_label,
    evidence?.result_label,
    result.eventual_outcome_label,
    result.outcome_label,
    result.later_outcome_label,
  )?.toLowerCase();

  if (outcomeLabel) {
    if (["worsened", "trade_worsened", "loss", "lost", "stopped_out", "gave_back", "adverse"].includes(outcomeLabel)) {
      return "useful";
    }
    if (["recovered", "strong_recovery", "winner", "won", "improved", "favorable"].includes(outcomeLabel)) {
      return "not_useful";
    }
    if (["mixed", "flat", "no_clear_edge"].includes(outcomeLabel)) return "mixed";
  }

  const finalReturn = typeof evidence?.final_return_pct === "number"
    ? evidence.final_return_pct
    : typeof result.final_return_pct === "number"
      ? result.final_return_pct
      : null;
  const pnl = typeof evidence?.eventual_pnl === "number"
    ? evidence.eventual_pnl
    : typeof result.eventual_pnl === "number"
      ? result.eventual_pnl
      : null;

  // Only use numeric evidence when an explicit outcome field exists. Do not infer
  // usefulness from unrelated PnL fields or missing data.
  if (outcomeLabel || evidence) {
    const value = finalReturn ?? pnl;
    if (typeof value === "number") {
      if (value < 0) return "useful";
      if (value > 0) return "not_useful";
    }
  }

  return "unknown";
}

function normalizeRow(row: SoftExitLearningSimulationRow): NormalizedSoftExitSimulation | null {
  if (row.status && row.status !== "completed") return null;

  const result = isRecord(row.result) ? row.result : {};
  const input = isRecord(row.input_snapshot) ? row.input_snapshot : {};
  const source = readString(result.source, input.source);
  const simulationType = readString(result.simulation_type, input.simulation_type);
  if (source && source !== "regime_change_soft_exit") return null;
  if (simulationType && simulationType !== "REGIME_CHANGE_SOFT_EXIT") return null;

  return {
    symbol: readString(row.symbol, result.symbol, input.symbol),
    side: normalizeSide(result.side ?? input.side),
    entryRegime: readString(result.entry_regime, input.entryRegime, input.entry_regime),
    currentRegime: readString(result.current_regime, input.currentRegime, input.current_regime),
    simulatedActions: normalizeActions(result.simulated_actions ?? result.simulatedActions ?? input.simulatedActions),
    severity: normalizeSeverity(result.severity),
    resultLabel: readString(result.result_label, input.resultLabel),
    reviewStatus: normalizeReviewStatus(row.review_status),
    usefulness: readOutcomeEvidence(result, input),
  };
}

function buildGroupKey(row: NormalizedSoftExitSimulation): string {
  return [
    row.symbol ?? "_",
    row.side ?? "_",
    row.entryRegime ?? "_",
    row.currentRegime ?? "_",
    row.simulatedActions.join("+"),
    row.severity,
    row.resultLabel ?? "_",
  ].join("|");
}

function sampleQuality(totalCount: number, reviewedSignalCount: number): SoftExitSampleQuality {
  if (totalCount >= SOFT_EXIT_STRONG_SAMPLE_COUNT && reviewedSignalCount >= SOFT_EXIT_STRONG_REVIEWED_COUNT) return "strong";
  if (totalCount >= SOFT_EXIT_EMERGING_SAMPLE_COUNT && reviewedSignalCount > 0) return "emerging";
  return "insufficient";
}

function recommendationFor(summary: Omit<SoftExitLearningSummary, "recommendation" | "recommendationType" | "executionAllowed">): Pick<SoftExitLearningSummary, "recommendation" | "recommendationType"> {
  const pattern = `${summary.symbol ?? "unknown symbol"} ${summary.side ?? "unknown side"} ${summary.entryRegime ?? "unknown"} → ${summary.currentRegime ?? "unknown"}`;
  if (summary.sampleQuality === "strong" && summary.reviewedCount > summary.dismissedCount) {
    return {
      recommendationType: "CONSIDER_EXPERIMENT_PROPOSAL",
      recommendation: `Strong reviewed soft-exit pattern for ${pattern}. Consider a future proposal-only experiment; do not change exits or execution behavior.`,
    };
  }
  if (summary.sampleQuality === "emerging") {
    return {
      recommendationType: "REVIEW_PATTERN",
      recommendation: `Emerging soft-exit pattern for ${pattern}. Hall/Wendy/Bobby should review more samples before any proposal.`,
    };
  }
  return {
    recommendationType: "KEEP_OBSERVING",
    recommendation: `Keep observing ${pattern}; samples or reviewed outcome evidence are insufficient for a proposal.`,
  };
}

export function aggregateSoftExitLearningSummaries(rows: SoftExitLearningSimulationRow[]): SoftExitLearningSummary[] {
  const groups = new Map<string, NormalizedSoftExitSimulation[]>();

  for (const row of rows) {
    const normalized = normalizeRow(row);
    if (!normalized) continue;
    const key = buildGroupKey(normalized);
    groups.set(key, [...(groups.get(key) ?? []), normalized]);
  }

  return Array.from(groups.entries()).map(([groupKey, groupRows]) => {
    const first = groupRows[0];
    const acknowledgedCount = groupRows.filter((row) => row.reviewStatus === "acknowledged").length;
    const reviewedCount = groupRows.filter((row) => row.reviewStatus === "reviewed").length;
    const dismissedCount = groupRows.filter((row) => row.reviewStatus === "dismissed").length;
    const unreviewedCount = groupRows.filter((row) => row.reviewStatus === "unreviewed").length;
    const usefulCount = groupRows.filter((row) => row.usefulness === "useful").length;
    const notUsefulCount = groupRows.filter((row) => row.usefulness === "not_useful").length;
    const reviewedSignalCount = acknowledgedCount + reviewedCount;
    const base = {
      groupKey,
      symbol: first.symbol,
      side: first.side,
      entryRegime: first.entryRegime,
      currentRegime: first.currentRegime,
      simulatedActions: first.simulatedActions,
      severity: first.severity,
      totalCount: groupRows.length,
      acknowledgedCount,
      reviewedCount,
      dismissedCount,
      unreviewedCount,
      usefulCount,
      notUsefulCount,
      sampleQuality: sampleQuality(groupRows.length, reviewedSignalCount),
    } satisfies Omit<SoftExitLearningSummary, "recommendation" | "recommendationType" | "executionAllowed">;
    const recommendation = recommendationFor(base);
    return {
      ...base,
      ...recommendation,
      executionAllowed: false,
    };
  }).sort((a, b) => {
    const qualityRank: Record<SoftExitSampleQuality, number> = { strong: 3, emerging: 2, insufficient: 1 };
    return qualityRank[b.sampleQuality] - qualityRank[a.sampleQuality]
      || b.totalCount - a.totalCount
      || a.groupKey.localeCompare(b.groupKey);
  });
}
