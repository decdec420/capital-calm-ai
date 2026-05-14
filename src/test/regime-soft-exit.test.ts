import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildRegimeSoftExitDecisionMemoryShape,
  evaluateRegimeSoftExit,
} from "@/lib/regime-soft-exit";
import { computePortfolioRisk } from "@/lib/portfolio-risk";

const NOW_MS = 1_700_000_000_000;
const fresh = new Date(NOW_MS - 60_000).toISOString();

const signalEngineSource = readFileSync("supabase/functions/signal-engine/index.ts", "utf8");
const portfolioRiskSource = readFileSync("src/lib/portfolio-risk.ts", "utf8");
const softExitSource = readFileSync("src/lib/regime-soft-exit.ts", "utf8");
const sharedSoftExitSource = readFileSync("supabase/functions/_shared/regime-soft-exit.ts", "utf8");

describe("direction fallback audit", () => {
  it("missing proposed side cannot become long inside portfolio-risk", () => {
    const risk = computePortfolioRisk({
      openTrades: [
        {
          id: "open-long",
          symbol: "BTC-USD",
          side: "long",
          directionBasis: null,
          entryPrice: 50_000,
          size: 0.001,
          originalSize: 0.001,
          unrealizedPnl: null,
          unrealizedPnlPct: null,
          currentPrice: 50_000,
          exitPrice: null,
          stopLoss: null,
          takeProfit: null,
          tp1Price: null,
          tp1Filled: false,
          pnl: null,
          pnlPct: null,
          status: "open",
          outcome: "open",
          reasonTags: [],
          strategyVersion: "test",
          strategyId: null,
          lifecyclePhase: "entered",
          lifecycleTransitions: [],
          notes: null,
          openedAt: fresh,
          closedAt: null,
        },
      ],
      proposedTrade: { symbol: "ETH-USD", side: null, notionalUsd: 10 },
      account: {
        id: "acct",
        equity: 10_000,
        cash: 10_000,
        startOfDayEquity: 10_000,
        balanceFloor: 8_000,
        baseCurrency: "USD",
        dailyAutoExecuteCapUsd: 2,
      },
      mode: "paper",
      exposureUpdatedAt: fresh,
      marketDataUpdatedAt: fresh,
      accountStateUpdatedAt: fresh,
      nowMs: NOW_MS,
    });

    expect(risk.openPositionCount).toBe(2);
    expect(risk.warningCodes).not.toContain("PORTFOLIO_DUPLICATE_DIRECTION_WARN");
  });

  it("unknown side records DEFAULT_LONG_FALLBACK_BLOCKED and does not use DOCTRINE_BLOCK as the primary reason", () => {
    expect(signalEngineSource).toContain("GATE_CODES.DEFAULT_LONG_FALLBACK_BLOCKED");
    expect(signalEngineSource).toContain('reasonCode: "DEFAULT_LONG_FALLBACK_BLOCKED"');
    expect(signalEngineSource).toContain("meta: { side: null }");
  });

  it("proposal path has no silent side fallback to long", () => {
    expect(signalEngineSource).not.toMatch(/side\s*\?\?\s*["']long["']/);
    expect(portfolioRiskSource).not.toContain('proposedTrade.side === "short" ? "short" as const : "long" as const');
    expect(portfolioRiskSource).toContain("normalizeProposedSide");
  });
});

describe("regime-change soft-exit simulation prep", () => {
  it("long position + trending_up → trending_down triggers simulation-only soft exit actions", () => {
    const result = evaluateRegimeSoftExit({
      side: "long",
      entryRegime: "trending_up",
      currentRegime: "trending_down",
      unrealizedPnl: -12,
      volatility: "elevated",
    });

    expect(result.shouldSimulate).toBe(true);
    expect(result.simulatedActions).toEqual(["TIGHTEN_STOP", "REDUCE_POSITION_50"]);
    expect(result.reasonCodes).toContain("LONG_TRENDING_UP_TO_DOWN");
    expect(result.executionAllowed).toBe(false);
  });

  it("short position + trending_down → trending_up triggers simulation-only soft exit actions", () => {
    const result = evaluateRegimeSoftExit({
      side: "short",
      entryRegime: "trending_down",
      currentRegime: "trending_up",
    });

    expect(result.shouldSimulate).toBe(true);
    expect(result.simulatedActions).toEqual(["TIGHTEN_STOP", "REDUCE_POSITION_50"]);
    expect(result.reasonCodes).toContain("SHORT_TRENDING_DOWN_TO_UP");
    expect(result.executionAllowed).toBe(false);
  });

  it("range/chop unchanged does not trigger an exit simulation", () => {
    const result = evaluateRegimeSoftExit({
      side: "long",
      entryRegime: "range",
      currentRegime: "chop",
    });

    expect(result.shouldSimulate).toBe(false);
    expect(result.simulatedActions).toEqual(["NO_ACTION"]);
    expect(result.reasonCodes).toContain("RANGE_CHOP_UNCHANGED");
    expect(result.executionAllowed).toBe(false);
  });

  it("unknown regime and missing side never allow execution", () => {
    expect(evaluateRegimeSoftExit({ side: "long", entryRegime: "unknown", currentRegime: "trending_down" })).toMatchObject({
      shouldSimulate: false,
      executionAllowed: false,
    });
    expect(evaluateRegimeSoftExit({ side: null, entryRegime: "trending_up", currentRegime: "trending_down" })).toMatchObject({
      shouldSimulate: false,
      executionAllowed: false,
      reasonCodes: ["MISSING_POSITION_SIDE", "DEFAULT_LONG_FALLBACK_BLOCKED"],
    });
  });

  it("decision-memory prep shape is dry-run only", () => {
    const shape = buildRegimeSoftExitDecisionMemoryShape({
      side: "long",
      entryRegime: "trending_up",
      currentRegime: "trending_down",
    });

    expect(shape.simulationType).toBe("regime_change_soft_exit");
    expect(shape.reasonCode).toBe("REGIME_CHANGE_SOFT_EXIT_SIMULATION");
    expect(shape.executionAllowed).toBe(false);
    expect(shape.result.executionAllowed).toBe(false);
  });

  it("soft-exit helpers do not create/close trades, call brokers, mutate doctrine, or mutate strategies", () => {
    for (const source of [softExitSource, sharedSoftExitSource]) {
      const executableSource = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      expect(executableSource).not.toMatch(/from\(["']trades["']\)|insert\(|update\(|delete\(/i);
      expect(executableSource).not.toMatch(/status\s*:\s*["']closed["']|closed_at|close.*position/i);
      expect(executableSource).not.toMatch(/broker|broker-execute|submit.*order|place.*order/i);
      expect(executableSource).not.toMatch(/doctrine|update.*strategy|mutate.*strategy/i);
      expect(executableSource).toMatch(/executionAllowed:\s*false/g);
    }
  });
});
