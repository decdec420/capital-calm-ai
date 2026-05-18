import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeTradeDecisionScore } from "./trade-decision-score.ts";
import type { RegimeResult } from "./regime.ts";
import { gate, GATE_CODES } from "./reasons.ts";

function regime(overrides: Partial<RegimeResult> = {}): RegimeResult {
  return {
    regime: "trending_up",
    confidence: 0.8,
    volatility: "normal",
    setupScore: 0.75,
    todScore: 0.8,
    pctChange: 1.2,
    annualizedVolPct: 40,
    pullback: false,
    rsiNow: 55,
    rsiPrev: 52,
    emaFast: 101,
    emaSlow: 100,
    slowRising: true,
    noTradeReasons: [],
    ...overrides,
  };
}

Deno.test("computeTradeDecisionScore maps setup bands to decision states", () => {
  assertEquals(computeTradeDecisionScore({ regime: regime({ setupScore: 0.39 }) }).state, "WATCHING");
  assertEquals(computeTradeDecisionScore({ regime: regime({ setupScore: 0.40 }) }).state, "SETUP_FORMING");
  assertEquals(computeTradeDecisionScore({ regime: regime({ setupScore: 0.60 }) }).state, "ENTRY_CANDIDATE");
  assertEquals(computeTradeDecisionScore({ regime: regime({ setupScore: 0.75 }) }).state, "TRADE_ALLOWED");
});

Deno.test("computeTradeDecisionScore hard risk gates override score", () => {
  const result = computeTradeDecisionScore({
    regime: regime({ setupScore: 0.92 }),
    riskGates: [gate(GATE_CODES.OPEN_POSITION, "block", "BTC-USD: position already open.")],
  });

  assertEquals(result.score, 92);
  assertEquals(result.state, "RISK_BLOCKED");
  assertEquals(result.riskBlocked, true);
  assertEquals(result.blockers, ["BTC-USD: position already open."]);
});
