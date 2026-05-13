import { describe, it, expect } from "vitest";
import {
  computePortfolioRisk,
  PORTFOLIO_RISK_CODES,
  MAX_TOTAL_EXPOSURE_PCT_WARN,
  MAX_TOTAL_EXPOSURE_PCT_BLOCK,
  MAX_SYMBOL_EXPOSURE_PCT_WARN,
  MAX_SYMBOL_EXPOSURE_PCT_BLOCK,
  CORRELATED_EXPOSURE_PCT_WARN,
  CORRELATED_EXPOSURE_PCT_BLOCK,
  MAX_OPEN_POSITIONS_WARN,
  MAX_OPEN_POSITIONS_BLOCK,
  type PortfolioRiskInput,
} from "@/lib/portfolio-risk";
import {
  computeTradingDecisionSnapshot,
  type TradingDecisionSnapshotInput,
} from "@/lib/trading-decision-snapshot";
import type { Trade, AccountState, SystemState, StrategyVersion, Alert } from "@/lib/domain-types";
import type { MarketIntelligence } from "@/hooks/useMarketIntelligence";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW_MS = 1_700_000_000_000;

function baseAccount(overrides: Partial<AccountState> = {}): AccountState {
  return {
    id: "acct1",
    equity: 10_000,
    cash: 10_000,
    startOfDayEquity: 10_000,
    balanceFloor: 8_000,
    baseCurrency: "USD",
    dailyAutoExecuteCapUsd: 2,
    ...overrides,
  };
}

function openTrade(
  symbol: string,
  entryPrice: number,
  size: number,
  overrides: Partial<Trade> = {},
): Trade {
  return {
    id: `trade-${symbol}-${Math.random()}`,
    symbol,
    side: "long",
    directionBasis: null,
    size,
    originalSize: size,
    entryPrice,
    exitPrice: null,
    stopLoss: null,
    takeProfit: null,
    tp1Price: null,
    tp1Filled: false,
    currentPrice: entryPrice,
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
    openedAt: new Date(NOW_MS - 60_000).toISOString(),
    closedAt: null,
    ...overrides,
  };
}

function baseInput(overrides: Partial<PortfolioRiskInput> = {}): PortfolioRiskInput {
  return {
    openTrades: [],
    account: baseAccount(),
    mode: "paper",
    exposureUpdatedAt: freshSnapshotRanAt(),
    marketDataUpdatedAt: freshSnapshotRanAt(),
    accountStateUpdatedAt: freshSnapshotRanAt(),
    nowMs: NOW_MS,
    ...overrides,
  };
}

// ─── snapshot fixtures (for snapshot integration tests) ───────────────────────

function freshSnapshotRanAt(): string {
  return new Date(NOW_MS - 60_000).toISOString();
}

function baseSystem(overrides: Partial<SystemState> = {}): SystemState {
  return {
    id: "s1",
    mode: "paper",
    bot: "running",
    brokerConnection: "connected",
    dataFeed: "connected",
    killSwitchEngaged: false,
    liveTradingEnabled: false,
    uptimeHours: 1,
    lastHeartbeat: new Date(NOW_MS).toISOString(),
    latencyMs: 10,
    autonomyLevel: "autonomous",
    lastEngineSnapshot: {
      ranAt: freshSnapshotRanAt(),
      gateReasons: [],
      perSymbol: [],
      chosenSymbol: null,
    },
    liveMoneyAcknowledgedAt: null,
    paperAccountBalance: 1000,
    paramsWiredLive: false,
    tradingPausedUntil: null,
    pauseReason: null,
    activeProfile: "active",
    lastJessicaDecision: null,
    doctrineOverlayToday: null,
    ...overrides,
  };
}

function freshMarketIntel(): MarketIntelligence {
  return {
    id: "mi1",
    symbol: "BTC-USD",
    macroBias: "neutral",
    macroConfidence: 0.5,
    marketPhase: "unknown",
    trendStructure: "unknown",
    nearestSupport: null,
    nearestResistance: null,
    keyLevelNotes: "",
    macroSummary: "",
    fundingRateSignal: "neutral",
    fundingRatePct: null,
    fearGreedScore: null,
    fearGreedLabel: null,
    sentimentSummary: "",
    environmentRating: "neutral",
    patternContext: "",
    entryQualityContext: "",
    generatedAt: new Date(NOW_MS - 30 * 60_000).toISOString(),
    recentMomentum1h: null,
    recentMomentum4h: null,
    recentMomentumAt: null,
    recentMomentumNotes: "",
    candleCount1h: null,
    candleCount4h: null,
    candleCount1d: null,
  };
}

function approvedStrategy(): StrategyVersion {
  return {
    id: "strat1",
    name: "momentum-burst",
    version: "1",
    displayName: "Momentum Burst",
    friendlySummary: null,
    status: "approved",
    createdAt: new Date(NOW_MS).toISOString(),
    description: "",
    params: [],
    metrics: { expectancy: 0.5, winRate: 0.6, maxDrawdown: 0.1, sharpe: 1.2, trades: 50 },
  };
}

function baseSnapshotInput(
  overrides: Partial<TradingDecisionSnapshotInput> = {},
): TradingDecisionSnapshotInput {
  return {
    system: baseSystem(),
    marketIntelligence: [freshMarketIntel()],
    strategies: [approvedStrategy()],
    alerts: [],
    nowMs: NOW_MS,
    ...overrides,
  };
}

// ─── computePortfolioRisk tests ───────────────────────────────────────────────

describe("computePortfolioRisk", () => {
  // ── Empty portfolio ────────────────────────────────────────────────────────

  it("empty portfolio returns clear verdict, zero exposure", () => {
    const result = computePortfolioRisk(baseInput());
    expect(result.verdict).toBe("clear");
    expect(result.totalExposureUsd).toBe(0);
    expect(result.openPositionCount).toBe(0);
    expect(result.blockCodes).toHaveLength(0);
    expect(result.warningCodes).toHaveLength(0);
  });

  it("empty portfolio with no account returns insufficientData = true", () => {
    const result = computePortfolioRisk(baseInput({ account: null }));
    expect(result.insufficientData).toBe(true);
  });

  it("empty portfolio with no account in paper mode does NOT block", () => {
    const result = computePortfolioRisk(baseInput({ account: null, mode: "paper" }));
    expect(result.blockCodes).not.toContain(PORTFOLIO_RISK_CODES.UNKNOWN_EXPOSURE_LIVE_BLOCK);
  });

  // ── Single small position ──────────────────────────────────────────────────

  it("single small BTC position ($1 notional on $10k equity) returns clear", () => {
    const result = computePortfolioRisk(
      baseInput({ openTrades: [openTrade("BTC-USD", 50_000, 0.00002)] }), // $1 notional
    );
    expect(result.verdict).toBe("clear");
    expect(result.blockCodes).toHaveLength(0);
    expect(result.warningCodes).toHaveLength(0);
  });

  it("computes notional = entryPrice × size", () => {
    const result = computePortfolioRisk(
      baseInput({ openTrades: [openTrade("BTC-USD", 50_000, 0.001)] }), // $50 notional
    );
    expect(result.totalExposureUsd).toBeCloseTo(50);
    expect(result.exposureBySymbol).toHaveLength(1);
    expect(result.exposureBySymbol[0].symbol).toBe("BTC-USD");
    expect(result.exposureBySymbol[0].notionalUsd).toBeCloseTo(50);
  });

  // ── Total exposure threshold ───────────────────────────────────────────────

  it("total exposure >= warn threshold returns warn code", () => {
    // $10k equity, need 30% = $3k exposure to warn
    const tradeSize = (10_000 * MAX_TOTAL_EXPOSURE_PCT_WARN) / 50_000;
    const result = computePortfolioRisk(
      baseInput({ openTrades: [openTrade("BTC-USD", 50_000, tradeSize)] }),
    );
    expect(result.warningCodes).toContain(PORTFOLIO_RISK_CODES.TOTAL_EXPOSURE_WARN);
    expect(result.blockCodes).not.toContain(PORTFOLIO_RISK_CODES.TOTAL_EXPOSURE_BLOCK);
    expect(result.verdict).toBe("warn");
  });

  it("total exposure >= block threshold returns block code", () => {
    // $10k equity, need 50% = $5k exposure to block
    const tradeSize = (10_000 * MAX_TOTAL_EXPOSURE_PCT_BLOCK) / 50_000;
    const result = computePortfolioRisk(
      baseInput({ openTrades: [openTrade("BTC-USD", 50_000, tradeSize)] }),
    );
    expect(result.blockCodes).toContain(PORTFOLIO_RISK_CODES.TOTAL_EXPOSURE_BLOCK);
    expect(result.verdict).toBe("block");
  });

  // ── Symbol concentration ───────────────────────────────────────────────────

  it("single symbol exposure >= warn threshold returns SYMBOL_EXPOSURE_WARN", () => {
    // $10k equity, 20% = $2k in one symbol
    const tradeSize = (10_000 * MAX_SYMBOL_EXPOSURE_PCT_WARN) / 50_000;
    const result = computePortfolioRisk(
      baseInput({ openTrades: [openTrade("BTC-USD", 50_000, tradeSize)] }),
    );
    expect(result.warningCodes).toContain(PORTFOLIO_RISK_CODES.SYMBOL_EXPOSURE_WARN);
  });

  it("single symbol exposure >= block threshold returns SYMBOL_EXPOSURE_BLOCK", () => {
    // $10k equity, 35% = $3500 in one symbol
    const tradeSize = (10_000 * MAX_SYMBOL_EXPOSURE_PCT_BLOCK) / 50_000;
    const result = computePortfolioRisk(
      baseInput({ openTrades: [openTrade("BTC-USD", 50_000, tradeSize)] }),
    );
    expect(result.blockCodes).toContain(PORTFOLIO_RISK_CODES.SYMBOL_EXPOSURE_BLOCK);
    expect(result.verdict).toBe("block");
  });

  // ── Correlated exposure ────────────────────────────────────────────────────

  it("BTC + ETH + SOL positions are grouped as crypto_major", () => {
    const btcSize = (10_000 * 0.05) / 50_000; // $500 BTC
    const ethSize = (10_000 * 0.05) / 2_000;  // $500 ETH
    const result = computePortfolioRisk(
      baseInput({
        openTrades: [
          openTrade("BTC-USD", 50_000, btcSize),
          openTrade("ETH-USD", 2_000, ethSize),
        ],
      }),
    );
    const cryptoMajor = result.correlatedExposure.find((g) => g.group === "crypto_major");
    expect(cryptoMajor).toBeDefined();
    expect(cryptoMajor!.activeSymbols).toContain("BTC-USD");
    expect(cryptoMajor!.activeSymbols).toContain("ETH-USD");
    expect(cryptoMajor!.totalNotionalUsd).toBeCloseTo(1_000, 1);
  });

  it("correlated exposure >= warn threshold returns CORRELATED_EXPOSURE_WARN", () => {
    // $10k equity, need 25% = $2500 in crypto_major group
    const btcSize = (10_000 * 0.13) / 50_000; // $1300 BTC
    const ethSize = (10_000 * 0.13) / 2_000;  // $1300 ETH — total $2600 > 25%
    const result = computePortfolioRisk(
      baseInput({
        openTrades: [
          openTrade("BTC-USD", 50_000, btcSize),
          openTrade("ETH-USD", 2_000, ethSize),
        ],
      }),
    );
    expect(result.warningCodes).toContain(PORTFOLIO_RISK_CODES.CORRELATED_EXPOSURE_WARN);
  });

  it("correlated exposure >= block threshold returns CORRELATED_EXPOSURE_BLOCK", () => {
    // $10k equity, need 40% = $4000 in crypto_major
    const btcSize = (10_000 * 0.21) / 50_000; // $2100 BTC
    const ethSize = (10_000 * 0.21) / 2_000;  // $2100 ETH — total $4200 > 40%
    const result = computePortfolioRisk(
      baseInput({
        openTrades: [
          openTrade("BTC-USD", 50_000, btcSize),
          openTrade("ETH-USD", 2_000, ethSize),
        ],
      }),
    );
    expect(result.blockCodes).toContain(PORTFOLIO_RISK_CODES.CORRELATED_EXPOSURE_BLOCK);
    expect(result.verdict).toBe("block");
  });

  it("non-correlated symbol (e.g. AAPL) does not appear in crypto_major group", () => {
    const result = computePortfolioRisk(
      baseInput({ openTrades: [openTrade("AAPL-USD", 150, 1)] }),
    );
    const cryptoMajor = result.correlatedExposure.find((g) => g.group === "crypto_major");
    expect(cryptoMajor?.activeSymbols).not.toContain("AAPL-USD");
  });

  // ── Open positions count ───────────────────────────────────────────────────

  it("open position count >= MAX_OPEN_POSITIONS_WARN returns OPEN_POSITIONS_WARN", () => {
    const trades = Array.from({ length: MAX_OPEN_POSITIONS_WARN }, (_, i) =>
      openTrade(`SYM${i}-USD`, 100, 0.01),
    );
    const result = computePortfolioRisk(baseInput({ openTrades: trades }));
    expect(result.warningCodes).toContain(PORTFOLIO_RISK_CODES.OPEN_POSITIONS_WARN);
  });

  it("open position count >= MAX_OPEN_POSITIONS_BLOCK returns OPEN_POSITIONS_BLOCK", () => {
    const trades = Array.from({ length: MAX_OPEN_POSITIONS_BLOCK }, (_, i) =>
      openTrade(`SYM${i}-USD`, 100, 0.01),
    );
    const result = computePortfolioRisk(baseInput({ openTrades: trades }));
    expect(result.blockCodes).toContain(PORTFOLIO_RISK_CODES.OPEN_POSITIONS_BLOCK);
    expect(result.verdict).toBe("block");
  });

  // ── Daily risk budget ──────────────────────────────────────────────────────

  it("daily risk budget low returns DAILY_RISK_BUDGET_LOW warning", () => {
    // dailyAutoExecuteCapUsd = 2; realized loss = -1.9 → remaining = 0.1 → 5% < 20%
    const result = computePortfolioRisk(
      baseInput({
        account: baseAccount({
          equity: 10_000 - 1.9,    // slightly down from start
          startOfDayEquity: 10_000,
          dailyAutoExecuteCapUsd: 2,
        }),
      }),
    );
    expect(result.warningCodes).toContain(PORTFOLIO_RISK_CODES.DAILY_RISK_BUDGET_LOW);
  });

  // ── Duplicate symbol stacking ──────────────────────────────────────────────

  it("two open positions on same symbol returns DUPLICATE_SYMBOL_WARN", () => {
    const result = computePortfolioRisk(
      baseInput({
        openTrades: [openTrade("BTC-USD", 50_000, 0.0001), openTrade("BTC-USD", 51_000, 0.0001)],
      }),
    );
    expect(result.warningCodes).toContain(PORTFOLIO_RISK_CODES.DUPLICATE_SYMBOL_WARN);
  });

  it("openPositionsBySymbol reflects per-symbol count", () => {
    const result = computePortfolioRisk(
      baseInput({
        openTrades: [
          openTrade("BTC-USD", 50_000, 0.0001),
          openTrade("BTC-USD", 51_000, 0.0001),
          openTrade("ETH-USD", 2_000, 0.001),
        ],
      }),
    );
    expect(result.openPositionsBySymbol["BTC-USD"]).toBe(2);
    expect(result.openPositionsBySymbol["ETH-USD"]).toBe(1);
  });

  it("two open positions with same direction returns DUPLICATE_DIRECTION_WARN", () => {
    const result = computePortfolioRisk(
      baseInput({
        openTrades: [
          openTrade("BTC-USD", 50_000, 0.0001, { side: "long" }),
          openTrade("ETH-USD", 2_000, 0.001, { side: "long" }),
        ],
      }),
    );
    expect(result.warningCodes).toContain(PORTFOLIO_RISK_CODES.DUPLICATE_DIRECTION_WARN);
  });

  it("opposite open directions do not return DUPLICATE_DIRECTION_WARN", () => {
    const result = computePortfolioRisk(
      baseInput({
        openTrades: [
          openTrade("BTC-USD", 50_000, 0.0001, { side: "long" }),
          openTrade("ETH-USD", 2_000, 0.001, { side: "short" }),
        ],
      }),
    );
    expect(result.warningCodes).not.toContain(PORTFOLIO_RISK_CODES.DUPLICATE_DIRECTION_WARN);
  });

  // ── Drawdown ───────────────────────────────────────────────────────────────

  it("drawdown exceeding 3% from start-of-day returns DRAWDOWN_WARN", () => {
    const result = computePortfolioRisk(
      baseInput({
        account: baseAccount({
          equity: 9_600,          // -4% from $10k start
          startOfDayEquity: 10_000,
        }),
        openTrades: [],
      }),
    );
    expect(result.warningCodes).toContain(PORTFOLIO_RISK_CODES.DRAWDOWN_WARN);
    expect(result.drawdownPct).toBeCloseTo(-0.04);
  });

  it("drawdown below 3% threshold does NOT warn", () => {
    const result = computePortfolioRisk(
      baseInput({
        account: baseAccount({
          equity: 9_800,          // -2% from $10k start
          startOfDayEquity: 10_000,
        }),
      }),
    );
    expect(result.warningCodes).not.toContain(PORTFOLIO_RISK_CODES.DRAWDOWN_WARN);
  });

  // ── Live mode strictness ───────────────────────────────────────────────────

  it("live mode with null account returns UNKNOWN_EXPOSURE_LIVE_BLOCK", () => {
    const result = computePortfolioRisk(baseInput({ account: null, mode: "live" }));
    expect(result.blockCodes).toContain(PORTFOLIO_RISK_CODES.UNKNOWN_EXPOSURE_LIVE_BLOCK);
    expect(result.verdict).toBe("block");
  });

  it("paper mode with null account does NOT return UNKNOWN_EXPOSURE_LIVE_BLOCK", () => {
    const result = computePortfolioRisk(baseInput({ account: null, mode: "paper" }));
    expect(result.blockCodes).not.toContain(PORTFOLIO_RISK_CODES.UNKNOWN_EXPOSURE_LIVE_BLOCK);
  });

  it("live mode with valid account and clear portfolio returns clear", () => {
    const result = computePortfolioRisk(baseInput({ mode: "live" }));
    expect(result.verdict).toBe("clear");
    expect(result.blockCodes).toHaveLength(0);
  });

  // ── Safety invariants ──────────────────────────────────────────────────────

  it("portfolio risk does NOT mutate the input openTrades array", () => {
    const trades = [openTrade("BTC-USD", 50_000, 0.001)];
    const originalLength = trades.length;
    computePortfolioRisk(baseInput({ openTrades: trades }));
    expect(trades.length).toBe(originalLength);
  });

  it("portfolio risk does NOT mutate the account object", () => {
    const account = baseAccount({ equity: 10_000 });
    const originalEquity = account.equity;
    computePortfolioRisk(baseInput({ account }));
    expect(account.equity).toBe(originalEquity);
  });

  it("portfolio risk does NOT create trades (returns summary only)", () => {
    const result = computePortfolioRisk(baseInput());
    // The result has no 'create', 'insert', or 'approve' methods
    expect(typeof result).toBe("object");
    expect((result as unknown as Record<string, unknown>).create).toBeUndefined();
    expect((result as unknown as Record<string, unknown>).insert).toBeUndefined();
    expect((result as unknown as Record<string, unknown>).approve).toBeUndefined();
  });

  it("portfolio risk does NOT approve signals", () => {
    const result = computePortfolioRisk(baseInput());
    expect((result as unknown as Record<string, unknown>).approveSignal).toBeUndefined();
  });

  it("portfolio risk does NOT mutate doctrine", () => {
    const account = baseAccount();
    const originalBalance = account.balanceFloor;
    computePortfolioRisk(baseInput({ account }));
    expect(account.balanceFloor).toBe(originalBalance);
  });

  it("portfolio risk does NOT mutate strategies", () => {
    // computePortfolioRisk doesn't accept strategies at all — verify input shape
    const input = baseInput();
    expect((input as unknown as Record<string, unknown>).strategies).toBeUndefined();
  });

  // ── Unrealized PnL aggregation ─────────────────────────────────────────────

  it("sums unrealized PnL across open positions when available", () => {
    const result = computePortfolioRisk(
      baseInput({
        openTrades: [
          openTrade("BTC-USD", 50_000, 0.001, { unrealizedPnl: 5 }),
          openTrade("ETH-USD", 2_000, 0.01, { unrealizedPnl: -2 }),
        ],
      }),
    );
    expect(result.totalUnrealizedPnl).toBeCloseTo(3);
  });

  it("totalUnrealizedPnl is null when no trades have MTM data", () => {
    const result = computePortfolioRisk(
      baseInput({
        openTrades: [openTrade("BTC-USD", 50_000, 0.001)],
      }),
    );
    expect(result.totalUnrealizedPnl).toBeNull();
  });

  // ── Exposure sorted desc ───────────────────────────────────────────────────

  it("exposureBySymbol is sorted descending by notional", () => {
    const result = computePortfolioRisk(
      baseInput({
        openTrades: [
          openTrade("ETH-USD", 2_000, 0.1),  // $200
          openTrade("BTC-USD", 50_000, 0.01), // $500
        ],
      }),
    );
    expect(result.exposureBySymbol[0].symbol).toBe("BTC-USD");
    expect(result.exposureBySymbol[1].symbol).toBe("ETH-USD");
  });

  // ── computedAt ────────────────────────────────────────────────────────────

  it("computedAt is derived from nowMs", () => {
    const result = computePortfolioRisk(baseInput({ nowMs: NOW_MS }));
    expect(result.computedAt).toBe(new Date(NOW_MS).toISOString());
  });
});

// ─── TradingDecisionSnapshot integration ──────────────────────────────────────

describe("TradingDecisionSnapshot + portfolio risk", () => {
  it("snapshot includes portfolioRisk when portfolioRiskInput is provided", () => {
    const snap = computeTradingDecisionSnapshot(
      baseSnapshotInput({
        portfolioRiskInput: { openTrades: [], account: baseAccount(), mode: "paper", exposureUpdatedAt: freshSnapshotRanAt(), marketDataUpdatedAt: freshSnapshotRanAt(), accountStateUpdatedAt: freshSnapshotRanAt() },
      }),
    );
    expect(snap.portfolioRisk).not.toBeNull();
    expect(snap.portfolioRisk?.verdict).toBe("clear");
  });

  it("snapshot.portfolioRisk is null when portfolioRiskInput is not provided", () => {
    const snap = computeTradingDecisionSnapshot(baseSnapshotInput());
    expect(snap.portfolioRisk).toBeNull();
  });

  it("portfolio block in PAPER mode does NOT set canTradeNow = false", () => {
    // 3 open positions = OPEN_POSITIONS_BLOCK in paper mode
    const trades = Array.from({ length: MAX_OPEN_POSITIONS_BLOCK }, (_, i) =>
      openTrade(`SYM${i}-USD`, 100, 0.01),
    );
    const snap = computeTradingDecisionSnapshot(
      baseSnapshotInput({
        system: baseSystem({ mode: "paper" }),
        portfolioRiskInput: { openTrades: trades, account: baseAccount(), mode: "paper" },
      }),
    );
    expect(snap.portfolioRisk?.verdict).toBe("block");
    // Paper mode: portfolio block is a warning blocker, NOT a canTradeNow block
    expect(snap.canTradeNow).toBe(true);
    // But the blocker IS surfaced in the blockers array
    expect(snap.blockers.some((b) => b.code === PORTFOLIO_RISK_CODES.OPEN_POSITIONS_BLOCK)).toBe(true);
  });

  it("portfolio block in LIVE mode sets canTradeNow = false", () => {
    const trades = Array.from({ length: MAX_OPEN_POSITIONS_BLOCK }, (_, i) =>
      openTrade(`SYM${i}-USD`, 100, 0.01),
    );
    const snap = computeTradingDecisionSnapshot(
      baseSnapshotInput({
        system: baseSystem({ mode: "live", brokerConnection: "connected", liveTradingEnabled: true }),
        portfolioRiskInput: { openTrades: trades, account: baseAccount(), mode: "live" },
      }),
    );
    expect(snap.portfolioRisk?.verdict).toBe("block");
    expect(snap.canTradeNow).toBe(false);
    expect(snap.blockers.some((b) => b.code === PORTFOLIO_RISK_CODES.OPEN_POSITIONS_BLOCK)).toBe(true);
  });

  it("live mode with null account includes UNKNOWN_EXPOSURE_LIVE_BLOCK blocker", () => {
    const snap = computeTradingDecisionSnapshot(
      baseSnapshotInput({
        system: baseSystem({ mode: "live", brokerConnection: "connected", liveTradingEnabled: true }),
        portfolioRiskInput: { openTrades: [], account: null, mode: "live" },
      }),
    );
    expect(snap.canTradeNow).toBe(false);
    expect(
      snap.blockers.some((b) => b.code === PORTFOLIO_RISK_CODES.UNKNOWN_EXPOSURE_LIVE_BLOCK),
    ).toBe(true);
  });

  it("portfolio warn codes appear as low-severity blockers in snapshot", () => {
    // 2 open positions = OPEN_POSITIONS_WARN
    const trades = Array.from({ length: MAX_OPEN_POSITIONS_WARN }, (_, i) =>
      openTrade(`SYM${i}-USD`, 100, 0.01),
    );
    const snap = computeTradingDecisionSnapshot(
      baseSnapshotInput({
        portfolioRiskInput: { openTrades: trades, account: baseAccount(), mode: "paper" },
      }),
    );
    const warnBlocker = snap.blockers.find(
      (b) => b.code === PORTFOLIO_RISK_CODES.OPEN_POSITIONS_WARN,
    );
    expect(warnBlocker).toBeDefined();
    expect(warnBlocker?.severity).toBe("low");
  });

  it("portfolio block codes in live mode are high-severity blockers in snapshot", () => {
    const trades = Array.from({ length: MAX_OPEN_POSITIONS_BLOCK }, (_, i) =>
      openTrade(`SYM${i}-USD`, 100, 0.01),
    );
    const snap = computeTradingDecisionSnapshot(
      baseSnapshotInput({
        system: baseSystem({ mode: "live", brokerConnection: "connected" }),
        portfolioRiskInput: { openTrades: trades, account: baseAccount(), mode: "live" },
      }),
    );
    const blockBlocker = snap.blockers.find(
      (b) => b.code === PORTFOLIO_RISK_CODES.OPEN_POSITIONS_BLOCK,
    );
    expect(blockBlocker).toBeDefined();
    expect(blockBlocker?.severity).toBe("high");
  });

  it("portfolio risk does not affect other existing gates (kill switch still works)", () => {
    const snap = computeTradingDecisionSnapshot(
      baseSnapshotInput({
        system: baseSystem({ killSwitchEngaged: true }),
        portfolioRiskInput: { openTrades: [], account: baseAccount(), mode: "paper", exposureUpdatedAt: freshSnapshotRanAt(), marketDataUpdatedAt: freshSnapshotRanAt(), accountStateUpdatedAt: freshSnapshotRanAt() },
      }),
    );
    expect(snap.killSwitchEngaged).toBe(true);
    expect(snap.canTradeNow).toBe(false);
    expect(snap.blockers.some((b) => b.code === "KILL_SWITCH")).toBe(true);
  });

  it("clear portfolio in paper mode leaves canTradeNow = true", () => {
    const snap = computeTradingDecisionSnapshot(
      baseSnapshotInput({
        portfolioRiskInput: {
          openTrades: [openTrade("BTC-USD", 50_000, 0.00002)], // tiny $1 position
          account: baseAccount(),
          mode: "paper",
          exposureUpdatedAt: freshSnapshotRanAt(),
          marketDataUpdatedAt: freshSnapshotRanAt(),
          accountStateUpdatedAt: freshSnapshotRanAt(),
        },
      }),
    );
    expect(snap.portfolioRisk?.verdict).toBe("clear");
    expect(snap.canTradeNow).toBe(true);
  });

  it("snapshot.portfolioRisk exposes totalExposure, exposureBySymbol, correlatedExposure", () => {
    const snap = computeTradingDecisionSnapshot(
      baseSnapshotInput({
        portfolioRiskInput: {
          openTrades: [openTrade("BTC-USD", 50_000, 0.001)],
          account: baseAccount(),
          mode: "paper",
        },
      }),
    );
    expect(snap.portfolioRisk?.totalExposureUsd).toBeCloseTo(50);
    expect(snap.portfolioRisk?.exposureBySymbol).toHaveLength(1);
    expect(snap.portfolioRisk?.correlatedExposure.length).toBeGreaterThan(0);
  });
});
