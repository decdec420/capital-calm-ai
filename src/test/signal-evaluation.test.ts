import { describe, expect, it } from "vitest";
import {
  MAX_SYMBOLS_EVALUATED_PER_TICK,
  MAX_SYMBOLS_EVALUATED_PER_TICK_AGGRESSIVE,
  SIGNAL_EVALUATION_SYMBOLS,
  selectSignalEvaluationCandidates,
} from "@/lib/signal-evaluation";
import { PORTFOLIO_RISK_CODES } from "@/lib/portfolio-risk";
import type { AccountState, Trade } from "@/lib/domain-types";

const NOW_MS = 1_700_000_000_000;
const FRESH = new Date(NOW_MS - 60_000).toISOString();

function account(overrides: Partial<AccountState> = {}): AccountState {
  return {
    id: "acct",
    equity: 10_000,
    cash: 10_000,
    startOfDayEquity: 10_000,
    balanceFloor: 8_000,
    baseCurrency: "USD",
    dailyAutoExecuteCapUsd: 2,
    ...overrides,
  };
}

function trade(symbol: string, notionalUsd: number, side: "long" | "short" = "long"): Trade {
  return {
    id: `trade-${symbol}-${side}`,
    symbol,
    side,
    directionBasis: "engine_chose_long",
    size: 1,
    originalSize: 1,
    entryPrice: notionalUsd,
    exitPrice: null,
    stopLoss: null,
    takeProfit: null,
    tp1Price: null,
    tp1Filled: false,
    currentPrice: notionalUsd,
    pnl: null,
    pnlPct: null,
    unrealizedPnl: null,
    unrealizedPnlPct: null,
    status: "open",
    outcome: "open",
    reasonTags: [],
    strategyVersion: "v1",
    strategyId: null,
    lifecyclePhase: "entered",
    lifecycleTransitions: [],
    notes: null,
    openedAt: FRESH,
    closedAt: null,
  };
}

const candidates = [
  { symbol: "SOL-USD", setupScore: 0.92, confidence: 0.65, momentumAgeMin: 4, brainTrustScore: "up", regime: "trending_up", lastPrice: 100 },
  { symbol: "BTC-USD", setupScore: 0.88, confidence: 0.7, momentumAgeMin: 3, brainTrustScore: "strong_up", regime: "trending_up", lastPrice: 60_000 },
  { symbol: "ETH-USD", setupScore: 0.81, confidence: 0.69, momentumAgeMin: 6, brainTrustScore: "up", regime: "trending_up", lastPrice: 3_000 },
] as const;

function portfolio(overrides: Partial<Parameters<typeof selectSignalEvaluationCandidates>[1]> = {}) {
  return {
    openTrades: [],
    account: account(),
    mode: "paper" as const,
    exposureUpdatedAt: FRESH,
    marketDataUpdatedAt: FRESH,
    accountStateUpdatedAt: FRESH,
    nowMs: NOW_MS,
    ...overrides,
  };
}

describe("signal evaluation candidate selection", () => {
  it("uses a controlled BTC/ETH/SOL evaluation universe", () => {
    expect(SIGNAL_EVALUATION_SYMBOLS).toEqual(["BTC-USD", "ETH-USD", "SOL-USD"]);
  });

  it("builds candidates for BTC-USD, ETH-USD, and SOL-USD and filters arbitrary symbols", () => {
    const result = selectSignalEvaluationCandidates([
      ...candidates,
      { symbol: "DOGE-USD", setupScore: 1, confidence: 1 },
    ], portfolio());
    expect(result.candidates.map((candidate) => candidate.symbol).sort()).toEqual(["BTC-USD", "ETH-USD", "SOL-USD"]);
  });

  it("evaluates more than SOL-USD while capping default enabled mode at top 2", () => {
    const result = selectSignalEvaluationCandidates([...candidates], portfolio(), "enabled");
    expect(result.maxEvaluated).toBe(MAX_SYMBOLS_EVALUATED_PER_TICK);
    expect(result.evaluated).toHaveLength(2);
    expect(result.evaluated.map((candidate) => candidate.symbol)).toContain("BTC-USD");
    expect(result.evaluated.map((candidate) => candidate.symbol)).toContain("SOL-USD");
  });

  it("canary mode can evaluate top 3", () => {
    const result = selectSignalEvaluationCandidates([...candidates], portfolio(), "canary");
    expect(result.maxEvaluated).toBe(MAX_SYMBOLS_EVALUATED_PER_TICK_AGGRESSIVE);
    expect(result.evaluated.map((candidate) => candidate.symbol).sort()).toEqual(["BTC-USD", "ETH-USD", "SOL-USD"]);
  });

  it("applies portfolio risk per candidate and lets a blocked SOL candidate not prevent BTC evaluation", () => {
    const result = selectSignalEvaluationCandidates([
      { ...candidates[0], proposedSide: "long", proposedNotionalUsd: 4_000 },
      { ...candidates[1], proposedSide: "short", proposedNotionalUsd: 100 },
    ], portfolio(), "enabled");
    const blockedSol = result.skipped.find((candidate) => candidate.symbol === "SOL-USD");
    expect(blockedSol?.skipCodes).toContain(PORTFOLIO_RISK_CODES.SYMBOL_EXPOSURE_BLOCK);
    expect(result.evaluated.map((candidate) => candidate.symbol)).toContain("BTC-USD");
  });

  it("correlated BTC/ETH/SOL exposure can block a candidate", () => {
    const result = selectSignalEvaluationCandidates([
      { ...candidates[2], proposedSide: "long", proposedNotionalUsd: 1_500 },
    ], portfolio({ openTrades: [trade("BTC-USD", 3_000, "long")] }), "enabled");
    expect(result.skipped[0].skipCodes).toContain(PORTFOLIO_RISK_CODES.CORRELATED_EXPOSURE_BLOCK);
  });

  it("duplicate-direction risk warns before proposal", () => {
    const result = selectSignalEvaluationCandidates([
      { ...candidates[1], proposedSide: "long", proposedNotionalUsd: 100 },
    ], portfolio({ openTrades: [trade("ETH-USD", 500, "long")] }), "enabled");
    expect(result.evaluated[0].portfolioRisk.warningCodes).toContain(PORTFOLIO_RISK_CODES.DUPLICATE_DIRECTION_WARN);
  });

  it("unknown and stale exposure block live-mode candidate proposal", () => {
    const result = selectSignalEvaluationCandidates([...candidates], {
      openTrades: [],
      account: null,
      mode: "live",
      nowMs: NOW_MS,
    }, "enabled");
    expect(result.evaluated).toHaveLength(0);
    expect(result.skipped[0].skipCodes).toContain(PORTFOLIO_RISK_CODES.UNKNOWN_EXPOSURE_LIVE_BLOCK);
    expect(result.skipped[0].skipCodes).toContain(PORTFOLIO_RISK_CODES.STALE_EXPOSURE);
  });

  it("paper mode warns/degrades on missing freshness instead of hard-blocking all scanning", () => {
    const result = selectSignalEvaluationCandidates([...candidates], {
      openTrades: [],
      account: account(),
      mode: "paper",
      nowMs: NOW_MS,
    }, "enabled");
    expect(result.evaluated).toHaveLength(2);
    expect(result.evaluated[0].portfolioRisk.warningCodes).toContain(PORTFOLIO_RISK_CODES.STALE_EXPOSURE);
  });
});
