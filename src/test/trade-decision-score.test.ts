import { describe, expect, it } from "vitest";
import { scoreTradeDecision } from "@/lib/trade-decision-score";
import type { MarketRegime } from "@/lib/domain-types";

function regime(overrides: Partial<MarketRegime> = {}): MarketRegime {
  return {
    symbol: "BTC-USD",
    regime: "trending_up",
    confidence: 0.7,
    volatility: "normal",
    spread: "tight",
    timeOfDayScore: 0.85,
    setupScore: 0.65,
    noTradeReasons: [],
    summary: "test",
    rsiNow: 52,
    rsiPrev: 48,
    emaFast: 100,
    emaSlow: 99,
    slowRising: true,
    pullback: true,
    annualizedVolPct: 45,
    pctChange: 1.2,
    rsiOverbought: false,
    rsiOversold: false,
    ...overrides,
  };
}

describe("scoreTradeDecision", () => {
  it("marks clean live-quality setups as entry candidates", () => {
    const output = scoreTradeDecision(regime());

    expect(output.decision).toBe("ENTRY CANDIDATE");
    expect(output.tradeScore).toBe(65);
    expect(output.activeBlockers).toEqual([]);
    expect(output.tradeAllowed).toBe(true);
  });

  it("prioritizes hard risk blockers over setup quality", () => {
    const output = scoreTradeDecision(regime({ volatility: "extreme", annualizedVolPct: 155 }));

    expect(output.decision).toBe("RISK BLOCKED");
    expect(output.tradeAllowed).toBe(false);
    expect(output.activeBlockers[0]).toContain("Extreme volatility");
  });

  it("keeps range RSI as context instead of primary trigger copy", () => {
    const output = scoreTradeDecision(regime({ regime: "range", setupScore: 0.5, pullback: false, rsiNow: 55 }));

    expect(output.decision).toBe("SETUP FORMING");
    expect(output.nextLikelyTrigger).toContain("RSI is only context");
    expect(output.activeBlockers.join(" ")).not.toContain("need ≥70");
  });
});
