import { describe, expect, it } from "vitest";
import { aggregateSoftExitLearningSummaries, type SoftExitLearningSimulationRow } from "@/lib/regime-soft-exit-learning";

function row(overrides: Partial<SoftExitLearningSimulationRow> & { id: string }): SoftExitLearningSimulationRow {
  return {
    status: "completed",
    symbol: "BTC-USD",
    review_status: "reviewed",
    input_snapshot: {
      source: "regime_change_soft_exit",
      symbol: "BTC-USD",
      entryRegime: "trending_up",
      currentRegime: "trending_down",
    },
    result: {
      simulation_type: "REGIME_CHANGE_SOFT_EXIT",
      source: "regime_change_soft_exit",
      side: "long",
      entry_regime: "trending_up",
      current_regime: "trending_down",
      simulated_actions: ["REDUCE_POSITION_50"],
      severity: "warning",
      result_label: "adverse_regime_flip",
      execution_allowed: false,
    },
    ...overrides,
  };
}

function many(count: number, reviewStatus: string): SoftExitLearningSimulationRow[] {
  return Array.from({ length: count }, (_, index) => row({ id: `${reviewStatus}-${index}`, review_status: reviewStatus }));
}

describe("aggregateSoftExitLearningSummaries", () => {
  it("groups simulations by symbol, side, regime, action, severity, and result label", () => {
    const summaries = aggregateSoftExitLearningSummaries([
      row({ id: "a" }),
      row({ id: "b" }),
      row({
        id: "c",
        symbol: "ETH-USD",
        input_snapshot: { source: "regime_change_soft_exit", symbol: "ETH-USD", entryRegime: "range", currentRegime: "chop" },
        result: {
          simulation_type: "REGIME_CHANGE_SOFT_EXIT",
          source: "regime_change_soft_exit",
          side: "short",
          entry_regime: "range",
          current_regime: "chop",
          simulated_actions: ["NO_ACTION"],
          severity: "info",
          result_label: "no_action",
          execution_allowed: false,
        },
      }),
    ]);

    expect(summaries).toHaveLength(2);
    expect(summaries.find((summary) => summary.symbol === "BTC-USD")?.totalCount).toBe(2);
    expect(summaries.find((summary) => summary.symbol === "ETH-USD")?.side).toBe("short");
  });

  it("aggregates review counts and counts dismissed without treating it as positive evidence", () => {
    const [summary] = aggregateSoftExitLearningSummaries([
      row({ id: "ack", review_status: "acknowledged" }),
      row({ id: "reviewed", review_status: "reviewed" }),
      row({ id: "dismissed", review_status: "dismissed" }),
      row({ id: "unreviewed", review_status: "unreviewed" }),
    ]);

    expect(summary.acknowledgedCount).toBe(1);
    expect(summary.reviewedCount).toBe(1);
    expect(summary.dismissedCount).toBe(1);
    expect(summary.unreviewedCount).toBe(1);
    expect(summary.sampleQuality).toBe("insufficient");
    expect(summary.recommendationType).toBe("KEEP_OBSERVING");
  });

  it("does not overweight unreviewed simulations when choosing sample quality", () => {
    const [summary] = aggregateSoftExitLearningSummaries(many(12, "unreviewed"));

    expect(summary.totalCount).toBe(12);
    expect(summary.unreviewedCount).toBe(12);
    expect(summary.sampleQuality).toBe("insufficient");
    expect(summary.recommendationType).toBe("KEEP_OBSERVING");
  });

  it("marks sample quality insufficient under the minimum count", () => {
    const [summary] = aggregateSoftExitLearningSummaries(many(4, "reviewed"));

    expect(summary.totalCount).toBe(4);
    expect(summary.sampleQuality).toBe("insufficient");
    expect(summary.recommendationType).toBe("KEEP_OBSERVING");
  });

  it("marks sample quality emerging and recommends pattern review with enough reviewed data", () => {
    const [summary] = aggregateSoftExitLearningSummaries(many(5, "reviewed"));

    expect(summary.sampleQuality).toBe("emerging");
    expect(summary.recommendationType).toBe("REVIEW_PATTERN");
  });

  it("marks sample quality strong and can suggest proposal-only experiment consideration", () => {
    const [summary] = aggregateSoftExitLearningSummaries(many(12, "reviewed"));

    expect(summary.sampleQuality).toBe("strong");
    expect(summary.recommendationType).toBe("CONSIDER_EXPERIMENT_PROPOSAL");
    expect(summary.recommendation).toContain("proposal-only experiment");
  });

  it("uses outcome evidence only when available", () => {
    const [summary] = aggregateSoftExitLearningSummaries([
      row({
        id: "useful",
        result: {
          simulation_type: "REGIME_CHANGE_SOFT_EXIT",
          source: "regime_change_soft_exit",
          side: "long",
          entry_regime: "trending_up",
          current_regime: "trending_down",
          simulated_actions: ["REDUCE_POSITION_50"],
          severity: "warning",
          result_label: "adverse_regime_flip",
          outcome_evidence: { outcome_label: "worsened" },
          execution_allowed: false,
        },
      }),
      row({
        id: "not-useful",
        result: {
          simulation_type: "REGIME_CHANGE_SOFT_EXIT",
          source: "regime_change_soft_exit",
          side: "long",
          entry_regime: "trending_up",
          current_regime: "trending_down",
          simulated_actions: ["REDUCE_POSITION_50"],
          severity: "warning",
          result_label: "adverse_regime_flip",
          outcome_evidence: { outcome_label: "recovered" },
          execution_allowed: false,
        },
      }),
      row({ id: "pending" }),
    ]);

    expect(summary.usefulCount).toBe(1);
    expect(summary.notUsefulCount).toBe(1);
  });

  it("does not invent usefulness when outcome evidence is missing", () => {
    const [summary] = aggregateSoftExitLearningSummaries([
      row({ id: "missing-outcome" }),
    ]);

    expect(summary.usefulCount).toBe(0);
    expect(summary.notUsefulCount).toBe(0);
    expect(summary.recommendation).toContain("insufficient");
  });

  it("always returns executionAllowed false", () => {
    const [summary] = aggregateSoftExitLearningSummaries([
      row({
        id: "bad-source-field",
        result: {
          simulation_type: "REGIME_CHANGE_SOFT_EXIT",
          source: "regime_change_soft_exit",
          side: "long",
          entry_regime: "trending_up",
          current_regime: "trending_down",
          simulated_actions: ["REDUCE_POSITION_50"],
          severity: "critical",
          result_label: "adverse_regime_flip",
          execution_allowed: true,
        },
      }),
    ]);

    expect(summary.executionAllowed).toBe(false);
  });

  it("does not expose any trade-closing, broker, stop, take-profit, doctrine, or strategy mutation API", () => {
    const source = aggregateSoftExitLearningSummaries.toString();

    expect(source).not.toMatch(/closeTrade|cancelOrder|placeTrade|broker|execute/i);
    expect(source).not.toMatch(/stop_loss|take_profit|doctrine|strateg/i);
  });

  it("ignores non-completed rows instead of treating queued simulations as evidence", () => {
    const summaries = aggregateSoftExitLearningSummaries([
      row({ id: "queued", status: "queued" }),
      row({ id: "completed", status: "completed" }),
    ]);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].totalCount).toBe(1);
  });
});
