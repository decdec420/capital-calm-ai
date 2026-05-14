import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assessExecutionDataReadiness } from "@/lib/execution-data-readiness";
import { computePortfolioRisk, type PortfolioRiskInput } from "@/lib/portfolio-risk";
import { assessPaperOpsReadiness } from "@/lib/paper-ops-readiness";
import type { AccountState, Trade } from "@/lib/domain-types";
import type { CronHealthRow } from "@/lib/cron-health";

const NOW_MS = 1_700_000_000_000;
const NOW = new Date(NOW_MS).toISOString();
const FRESH = new Date(NOW_MS - 60_000).toISOString();
const SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;

type SmokeCandidate = {
  symbol: typeof SYMBOLS[number];
  score: number;
  proposedNotionalUsd: number;
  unsafeDoctrineReason?: string;
};

type SmokeDependencies = {
  brokerExecute: (candidate: SmokeCandidate) => Promise<unknown>;
  approveLiveSignal: (candidate: SmokeCandidate) => Promise<unknown>;
  mutateDoctrine: (patch: Record<string, unknown>) => void;
  mutateStrategy: (patch: Record<string, unknown>) => void;
};

function account(overrides: Partial<AccountState> = {}): AccountState {
  return {
    id: "paper-acct-1",
    equity: 10_000,
    cash: 10_000,
    startOfDayEquity: 10_000,
    balanceFloor: 8_000,
    baseCurrency: "USD",
    dailyAutoExecuteCapUsd: 2,
    ...overrides,
  };
}

function openTrade(symbol: string, notionalUsd: number): Trade {
  return {
    id: `open-${symbol}`,
    symbol,
    side: "long",
    directionBasis: null,
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
    strategyVersion: "paper-smoke-v1",
    strategyId: "strategy-paper-smoke",
    lifecyclePhase: "entered",
    lifecycleTransitions: [],
    notes: null,
    openedAt: FRESH,
    closedAt: null,
  };
}

function cronRow(jobName: string, severity: CronHealthRow["severity"] = "ok"): CronHealthRow {
  return {
    jobName,
    category: jobName.includes("market") ? "market_data" : jobName.includes("learning") ? "learning" : "trading",
    configured: severity !== "critical",
    lastRunAt: FRESH,
    lastStatus: severity === "critical" ? "failed" : "succeeded",
    lastSafeMessage: null,
    expectedEverySeconds: 300,
    stale: false,
    severity,
    userAttentionRequired: severity === "critical",
  };
}

function greenCronRows(): CronHealthRow[] {
  return [
    cronRow("market-intelligence-4h"),
    cronRow("signal-engine-tick"),
    cronRow("process-decision-memory"),
    cronRow("strategy-learning"),
    cronRow("hall-tick-5m"),
  ];
}

function runPaperSmoke(deps: SmokeDependencies) {
  const doctrineBefore = Object.freeze({ maxOrderPct: 0.05, liveTradingEnabled: false });
  const strategyBefore = Object.freeze({ id: "strategy-paper-smoke", status: "approved", version: "paper-smoke-v1" });

  const marketContext = SYMBOLS.map((symbol, index) => ({
    symbol,
    generatedAt: NOW,
    macroBias: index === 0 ? "bullish" : "neutral",
    recentMomentumScore: 0.55 + index * 0.05,
  }));

  const candidates: SmokeCandidate[] = [
    { symbol: "BTC-USD", score: 0.78, proposedNotionalUsd: 125 },
    { symbol: "ETH-USD", score: 0.64, proposedNotionalUsd: 125, unsafeDoctrineReason: "SETUP_SCORE_BELOW_THRESHOLD" },
    { symbol: "SOL-USD", score: 0.58, proposedNotionalUsd: 20 },
  ];

  const openTrades = [openTrade("BTC-USD", 5_500)];
  const riskInputs: PortfolioRiskInput[] = candidates.map((candidate) => ({
    openTrades,
    proposedTrade: { symbol: candidate.symbol, side: "long", notionalUsd: candidate.proposedNotionalUsd },
    account: account(),
    mode: "paper",
    exposureUpdatedAt: FRESH,
    marketDataUpdatedAt: FRESH,
    accountStateUpdatedAt: FRESH,
    nowMs: NOW_MS,
  }));
  const riskEvaluations = riskInputs.map((input) => ({
    symbol: input.proposedTrade?.symbol,
    summary: computePortfolioRisk(input),
  }));

  const paperProposal = candidates.find((candidate) => !candidate.unsafeDoctrineReason && candidate.symbol === "BTC-USD")!;
  const blockedCandidate = candidates.find((candidate) => candidate.unsafeDoctrineReason)!;

  const replayPacket = {
    id: "replay-paper-smoke-1",
    mode: "paper",
    symbolsConsidered: [...SYMBOLS],
    chosenSymbol: paperProposal.symbol,
    gateTrace: riskEvaluations.map((row) => ({ symbol: row.symbol, verdict: row.summary.verdict, blockCodes: row.summary.blockCodes })),
    liveExecutionAllowed: false as const,
  };

  const decisionMemory = [
    { symbol: paperProposal.symbol, status: "proposed", mode: "paper", replayPacketId: replayPacket.id },
    { symbol: blockedCandidate.symbol, status: "blocked", reason: blockedCandidate.unsafeDoctrineReason, replayPacketId: replayPacket.id },
    { symbol: "SOL-USD", status: "skipped", reason: "lower_score", replayPacketId: replayPacket.id },
  ];

  const executionReadiness = assessExecutionDataReadiness({
    expectedPrice: 65_000,
    orderType: "paper_market",
    makerTakerFlag: "not_applicable_paper",
    quoteSnapshot: { symbol: paperProposal.symbol, bid: 64_995, ask: 65_005, capturedAt: NOW },
    decisionTimestamp: NOW,
  });

  const simulationEnrichment = {
    sourceDecisionMemoryId: decisionMemory[0].replayPacketId,
    symbol: paperProposal.symbol,
    labels: ["paper_only", "no_live_fill"],
    executionAllowed: false as const,
  };

  const strategyLearningRecommendation = {
    strategyId: strategyBefore.id,
    recommendationType: "parameter_review",
    reviewRequired: true,
    proposalOnly: true,
    liveExecutionAllowed: false as const,
  };

  const experimentProposal = {
    experimentId: "exp-paper-smoke-1",
    status: "needs_review",
    reviewOnly: true,
    approvedForLive: false,
  };

  const softExitSimulation = {
    reason: "REGIME_CHANGE_SOFT_EXIT",
    reviewRequired: true,
    executionAllowed: false as const,
    liveExecutionAllowed: false as const,
  };

  const opsReadiness = assessPaperOpsReadiness({
    liveModeEnabled: false,
    brokerExecutionEnabled: false,
    cronHealthRows: greenCronRows(),
    quietModeVisible: true,
    executionDataReadiness: executionReadiness,
    portfolioRisk: riskEvaluations[0].summary,
    opsIncidents: [],
    opsTimelineVisible: true,
    doctrineGatesVisible: true,
    paperOnlyPathVisible: true,
  });

  return {
    doctrineBefore,
    doctrineAfter: doctrineBefore,
    strategyBefore,
    strategyAfter: strategyBefore,
    marketContext,
    candidates,
    riskEvaluations,
    paperProposal,
    blockedCandidate,
    replayPacket,
    decisionMemory,
    executionReadiness,
    simulationEnrichment,
    strategyLearningRecommendation,
    experimentProposal,
    softExitSimulation,
    opsSurfaces: {
      quietMode: { mode: "normal", safetyChecksPreserved: true },
      cronHealth: { rows: greenCronRows() },
      executionDataReadiness: executionReadiness,
      hallOpsTimeline: { incidents: [] },
    },
    opsReadiness,
    deps,
  };
}

describe("end-to-end paper trading smoke fixture", () => {
  it("represents the paper company loop without enabling live execution", () => {
    const deps: SmokeDependencies = {
      brokerExecute: vi.fn(),
      approveLiveSignal: vi.fn(),
      mutateDoctrine: vi.fn(),
      mutateStrategy: vi.fn(),
    };

    const smoke = runPaperSmoke(deps);

    expect(smoke.marketContext.map((row) => row.symbol)).toEqual(["BTC-USD", "ETH-USD", "SOL-USD"]);
    expect(smoke.candidates).toHaveLength(3);
    expect(new Set(smoke.riskEvaluations.map((row) => row.symbol))).toEqual(new Set(SYMBOLS));
    expect(smoke.blockedCandidate.unsafeDoctrineReason).toBe("SETUP_SCORE_BELOW_THRESHOLD");
    expect(smoke.paperProposal.symbol).toBe("BTC-USD");
    expect(smoke.replayPacket).toMatchObject({ mode: "paper", liveExecutionAllowed: false, symbolsConsidered: ["BTC-USD", "ETH-USD", "SOL-USD"] });
    expect(smoke.decisionMemory.map((row) => row.status).sort()).toEqual(["blocked", "proposed", "skipped"]);
    expect(smoke.simulationEnrichment).toMatchObject({ labels: ["paper_only", "no_live_fill"], executionAllowed: false });
    expect(smoke.strategyLearningRecommendation).toMatchObject({ proposalOnly: true, reviewRequired: true, liveExecutionAllowed: false });
    expect(smoke.experimentProposal).toMatchObject({ status: "needs_review", reviewOnly: true, approvedForLive: false });
    expect(smoke.softExitSimulation).toMatchObject({ reason: "REGIME_CHANGE_SOFT_EXIT", executionAllowed: false, liveExecutionAllowed: false });
    expect(smoke.opsSurfaces).toHaveProperty("quietMode");
    expect(smoke.opsSurfaces).toHaveProperty("cronHealth");
    expect(smoke.opsSurfaces).toHaveProperty("executionDataReadiness");
    expect(smoke.opsSurfaces).toHaveProperty("hallOpsTimeline");
    expect(smoke.opsReadiness.liveExecutionAllowed).toBe(false);
  });

  it("cannot call broker execution, approve live signals, or mutate doctrine/strategies", () => {
    const deps: SmokeDependencies = {
      brokerExecute: vi.fn(),
      approveLiveSignal: vi.fn(),
      mutateDoctrine: vi.fn(),
      mutateStrategy: vi.fn(),
    };

    const smoke = runPaperSmoke(deps);

    expect(deps.brokerExecute).not.toHaveBeenCalled();
    expect(deps.approveLiveSignal).not.toHaveBeenCalled();
    expect(deps.mutateDoctrine).not.toHaveBeenCalled();
    expect(deps.mutateStrategy).not.toHaveBeenCalled();
    expect(smoke.doctrineAfter).toBe(smoke.doctrineBefore);
    expect(smoke.strategyAfter).toBe(smoke.strategyBefore);
  });
});

describe("paper ops readiness model", () => {
  it("returns blocked when critical cron health fails", () => {
    const readiness = assessPaperOpsReadiness({
      liveModeEnabled: false,
      brokerExecutionEnabled: false,
      cronHealthRows: [cronRow("market-intelligence-4h"), cronRow("signal-engine-tick", "critical"), cronRow("process-decision-memory"), cronRow("strategy-learning"), cronRow("hall-tick-5m")],
      quietModeVisible: true,
      executionDataReadiness: assessExecutionDataReadiness({ expectedPrice: 1 }),
      portfolioRisk: computePortfolioRisk({ openTrades: [], account: account(), mode: "paper", exposureUpdatedAt: FRESH, marketDataUpdatedAt: FRESH, accountStateUpdatedAt: FRESH, nowMs: NOW_MS }),
      opsIncidents: [],
      opsTimelineVisible: true,
      doctrineGatesVisible: true,
      paperOnlyPathVisible: true,
    });

    expect(readiness.status).toBe("blocked");
    expect(readiness.blockers.some((blocker) => blocker.includes("signal-engine-tick"))).toBe(true);
    expect(readiness.liveExecutionAllowed).toBe(false);
  });

  it("returns blocked when live execution appears enabled while preserving the false invariant", () => {
    const readiness = assessPaperOpsReadiness({
      liveModeEnabled: true,
      brokerExecutionEnabled: true,
      cronHealthRows: greenCronRows(),
      quietModeVisible: true,
      executionDataReadiness: assessExecutionDataReadiness({}),
      portfolioRisk: computePortfolioRisk({ openTrades: [], account: account(), mode: "paper", exposureUpdatedAt: FRESH, marketDataUpdatedAt: FRESH, accountStateUpdatedAt: FRESH, nowMs: NOW_MS }),
      opsIncidents: [],
      opsTimelineVisible: true,
      doctrineGatesVisible: true,
      paperOnlyPathVisible: true,
    });

    expect(readiness.status).toBe("blocked");
    expect(readiness.blockers).toEqual(expect.arrayContaining([
      "Live mode is enabled; the 7-day run must be paper-only.",
      "Broker execution appears enabled; disable live order placement before the paper run.",
    ]));
    expect(readiness.liveExecutionAllowed).toBe(false);
  });

  it("warns when execution-data readiness is insufficient", () => {
    const readiness = assessPaperOpsReadiness({
      liveModeEnabled: false,
      brokerExecutionEnabled: false,
      cronHealthRows: greenCronRows(),
      quietModeVisible: true,
      executionDataReadiness: assessExecutionDataReadiness({}),
      portfolioRisk: computePortfolioRisk({ openTrades: [], account: account(), mode: "paper", exposureUpdatedAt: FRESH, marketDataUpdatedAt: FRESH, accountStateUpdatedAt: FRESH, nowMs: NOW_MS }),
      opsIncidents: [],
      opsTimelineVisible: true,
      doctrineGatesVisible: true,
      paperOnlyPathVisible: true,
    });

    expect(readiness.status).toBe("ready_for_7_day_paper_run");
    expect(readiness.warnings.some((warning) => warning.includes("Execution-data readiness is insufficient"))).toBe(true);
    expect(readiness.checks.find((row) => row.id === "execution_data_readiness")?.status).toBe("warn");
  });

  it("passes when core ops checks are green", () => {
    const readiness = assessPaperOpsReadiness({
      liveModeEnabled: false,
      brokerExecutionEnabled: false,
      cronHealthRows: greenCronRows(),
      quietModeVisible: true,
      executionDataReadiness: assessExecutionDataReadiness({
        expectedPrice: 1,
        actualFillPrice: 1,
        orderType: "market",
        makerTakerFlag: "taker",
        fees: 0.01,
        spread: 1,
        slippage: 0.1,
        timeToFill: 100,
        partialFillStatus: "filled",
        quoteSnapshot: { bid: 0.99, ask: 1.01, capturedAt: NOW },
        decisionTimestamp: NOW,
        fillTimestamp: NOW,
      }),
      portfolioRisk: computePortfolioRisk({ openTrades: [], account: account(), mode: "paper", exposureUpdatedAt: FRESH, marketDataUpdatedAt: FRESH, accountStateUpdatedAt: FRESH, nowMs: NOW_MS }),
      opsIncidents: [],
      opsTimelineVisible: true,
      doctrineGatesVisible: true,
      paperOnlyPathVisible: true,
    });

    expect(readiness.status).toBe("ready_for_7_day_paper_run");
    expect(readiness.blockers).toEqual([]);
    expect(readiness.checks.filter((row) => row.status === "pass").length).toBe(readiness.checks.length);
    expect(readiness.liveExecutionAllowed).toBe(false);
  });
});

describe("7-day paper trading readiness runbook", () => {
  it("contains required stop conditions", () => {
    const doc = readFileSync(resolve(process.cwd(), "docs/ops/7-day-paper-trading-readiness.md"), "utf8");

    [
      "live broker order attempted",
      "doctrine/risk mutation without review",
      "strategy mutation without review",
      "unknown exposure in live mode",
      "missing cron critical job",
      "repeated critical Hall/Ops incidents",
      "system_events runaway growth",
      "raw secret exposure",
      "costs/IO spike",
    ].forEach((phrase) => expect(doc.toLowerCase()).toContain(phrase.toLowerCase()));
  });
});
