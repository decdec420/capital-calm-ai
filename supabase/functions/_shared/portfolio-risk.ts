// ============================================================
// Portfolio-Level Risk — _shared edition (Deno-compatible)
// ------------------------------------------------------------
// Pure input → risk summary. No side effects. No DB calls.
// No broker calls. No trade creation. No doctrine mutation.
//
// Mirrors src/lib/portfolio-risk.ts but accepts raw DB row
// shapes (snake_case) so signal-engine can import it directly
// without transforming to frontend camelCase types.
//
// Sync with src/lib/portfolio-risk.ts when thresholds change.
// ============================================================

// ─── Correlated symbol groups ────────────────────────────────────────────────

export const CORRELATED_GROUPS: Record<string, string[]> = {
  crypto_major: ["BTC-USD", "ETH-USD", "SOL-USD"],
};

// ─── Thresholds ──────────────────────────────────────────────────────────────

export const MAX_TOTAL_EXPOSURE_PCT_WARN = 0.3;
export const MAX_TOTAL_EXPOSURE_PCT_BLOCK = 0.5;
export const MAX_SYMBOL_EXPOSURE_PCT_WARN = 0.2;
export const MAX_SYMBOL_EXPOSURE_PCT_BLOCK = 0.35;
export const CORRELATED_EXPOSURE_PCT_WARN = 0.25;
export const CORRELATED_EXPOSURE_PCT_BLOCK = 0.4;
export const MAX_OPEN_POSITIONS_WARN = 2;
export const MAX_OPEN_POSITIONS_BLOCK = 3;
export const DAILY_RISK_BUDGET_LOW_FRACTION = 0.2;
export const DRAWDOWN_WARN_PCT = 0.03;
export const DUPLICATE_SYMBOL_WARN_COUNT = 2;
export const STALE_INPUT_MAX_AGE_MS = 5 * 60_000;

// ─── Portfolio risk verdict ───────────────────────────────────────────────────

export type PortfolioRiskVerdict = "clear" | "warn" | "block";

// ─── Portfolio risk codes ────────────────────────────────────────────────────

export const PORTFOLIO_RISK_CODES = {
  // Warnings
  TOTAL_EXPOSURE_WARN: "PORTFOLIO_TOTAL_EXPOSURE_WARN",
  SYMBOL_EXPOSURE_WARN: "PORTFOLIO_SYMBOL_EXPOSURE_WARN",
  CORRELATED_EXPOSURE_WARN: "PORTFOLIO_CORRELATED_EXPOSURE_WARN",
  OPEN_POSITIONS_WARN: "PORTFOLIO_OPEN_POSITIONS_WARN",
  DAILY_RISK_BUDGET_LOW: "PORTFOLIO_DAILY_RISK_BUDGET_LOW",
  DRAWDOWN_WARN: "PORTFOLIO_DRAWDOWN_WARN",
  OVERTRADING_WARN: "PORTFOLIO_OVERTRADING_WARN",
  DUPLICATE_SYMBOL_WARN: "PORTFOLIO_DUPLICATE_SYMBOL_WARN",
  DUPLICATE_DIRECTION_WARN: "PORTFOLIO_DUPLICATE_DIRECTION_WARN",
  // Blocks
  TOTAL_EXPOSURE_BLOCK: "PORTFOLIO_TOTAL_EXPOSURE_BLOCK",
  SYMBOL_EXPOSURE_BLOCK: "PORTFOLIO_SYMBOL_EXPOSURE_BLOCK",
  CORRELATED_EXPOSURE_BLOCK: "PORTFOLIO_CORRELATED_EXPOSURE_BLOCK",
  OPEN_POSITIONS_BLOCK: "PORTFOLIO_OPEN_POSITIONS_BLOCK",
  // Live-only blocks
  UNKNOWN_EXPOSURE_LIVE_BLOCK: "PORTFOLIO_UNKNOWN_EXPOSURE_LIVE_BLOCK",
  STALE_EXPOSURE: "STALE_EXPOSURE",
  STALE_MARKET_DATA: "STALE_MARKET_DATA",
  STALE_ACCOUNT_STATE: "STALE_ACCOUNT_STATE",
} as const;

export type PortfolioRiskCode =
  (typeof PORTFOLIO_RISK_CODES)[keyof typeof PORTFOLIO_RISK_CODES];

// ─── DB-row input shapes (snake_case) ─────────────────────────────────────────

/** Minimal subset of a trades DB row needed for portfolio risk. */
export interface DbTradeForPortfolioRisk {
  symbol: string;
  entry_price: number | string | null;
  size: number | string | null;
  unrealized_pnl?: number | string | null;
  side?: "long" | "short" | string | null;
}

/** Minimal subset of an account_state DB row needed for portfolio risk. */
export interface DbAccountStateForPortfolioRisk {
  equity: number | string | null;
  start_of_day_equity?: number | string | null;
  daily_auto_execute_cap_usd?: number | string | null;
}

// ─── Output shapes (identical to frontend portfolio-risk.ts) ─────────────────

export interface SymbolExposure {
  symbol: string;
  notionalUsd: number;
  unrealizedPnl: number | null;
  openPositionCount: number;
}

export interface CorrelatedGroupExposure {
  group: string;
  symbols: string[];
  activeSymbols: string[];
  totalNotionalUsd: number;
}

export interface PortfolioRiskSummary {
  verdict: PortfolioRiskVerdict;
  warningCodes: PortfolioRiskCode[];
  blockCodes: PortfolioRiskCode[];
  totalExposureUsd: number;
  exposureBySymbol: SymbolExposure[];
  correlatedExposure: CorrelatedGroupExposure[];
  openPositionCount: number;
  openPositionsBySymbol: Record<string, number>;
  dailyRealizedPnl: number | null;
  totalUnrealizedPnl: number | null;
  dailyRiskBudgetRemaining: number | null;
  equityUsd: number | null;
  startOfDayEquityUsd: number | null;
  drawdownUsd: number | null;
  drawdownPct: number | null;
  insufficientData: boolean;
  computedAt: string;
}

// ─── Input shape ─────────────────────────────────────────────────────────────

export interface PortfolioRiskInput {
  /** Open trades (status = 'open'). Caller filters. */
  openTrades: DbTradeForPortfolioRisk[];
  /** Optional proposed candidate, included before proposal/insert. */
  proposedTrade?: { symbol: string; side?: "long" | "short" | string | null; notionalUsd: number } | null;
  /** Account state — null when unavailable. */
  account: DbAccountStateForPortfolioRisk | null;
  /** System mode drives paper-vs-live strictness. */
  mode: "paper" | "live" | "unknown";
  /** Last reliable exposure snapshot timestamp. Missing is never fresh in live mode. */
  exposureUpdatedAt?: string | null;
  /** Last reliable market-data timestamp. Missing is never fresh in live mode. */
  marketDataUpdatedAt?: string | null;
  /** Last reliable account-state timestamp. Missing is never fresh in live mode. */
  accountStateUpdatedAt?: string | null;
  /** Current time in ms (for testability). */
  nowMs?: number;
}

// ─── Pure compute ─────────────────────────────────────────────────────────────

export function computePortfolioRisk(input: PortfolioRiskInput): PortfolioRiskSummary {
  const { openTrades, account, mode } = input;
  const nowMs = input.nowMs ?? Date.now();
  const isLiveMode = mode === "live";

  const warningCodes: PortfolioRiskCode[] = [];
  const blockCodes: PortfolioRiskCode[] = [];

  // ── Data quality ──────────────────────────────────────────────────────────
  const staleOrMissing = (timestamp: string | null | undefined): boolean => {
    if (!timestamp) return true;
    const parsed = new Date(timestamp).getTime();
    return !Number.isFinite(parsed) || nowMs - parsed > STALE_INPUT_MAX_AGE_MS || parsed > nowMs + 60_000;
  };

  const exposureStale = staleOrMissing(input.exposureUpdatedAt);
  const marketDataStale = staleOrMissing(input.marketDataUpdatedAt);
  const accountStateStale = staleOrMissing(input.accountStateUpdatedAt);

  const insufficientData = account === null || (isLiveMode && (exposureStale || accountStateStale));
  if (isLiveMode && account === null) {
    blockCodes.push(PORTFOLIO_RISK_CODES.UNKNOWN_EXPOSURE_LIVE_BLOCK);
  }
  if (isLiveMode && exposureStale) {
    blockCodes.push(PORTFOLIO_RISK_CODES.STALE_EXPOSURE);
  } else if (!isLiveMode && exposureStale) {
    warningCodes.push(PORTFOLIO_RISK_CODES.STALE_EXPOSURE);
  }
  if (isLiveMode && marketDataStale) {
    blockCodes.push(PORTFOLIO_RISK_CODES.STALE_MARKET_DATA);
  } else if (!isLiveMode && marketDataStale) {
    warningCodes.push(PORTFOLIO_RISK_CODES.STALE_MARKET_DATA);
  }
  if (isLiveMode && accountStateStale) {
    blockCodes.push(PORTFOLIO_RISK_CODES.STALE_ACCOUNT_STATE);
  } else if (!isLiveMode && accountStateStale) {
    warningCodes.push(PORTFOLIO_RISK_CODES.STALE_ACCOUNT_STATE);
  }

  // ── Exposure by symbol ────────────────────────────────────────────────────
  const symbolMap = new Map<string, SymbolExposure>();
  const proposedTrade = input.proposedTrade ?? null;
  const exposureRows = proposedTrade && proposedTrade.notionalUsd >= 0
    ? [
        ...openTrades,
        {
          symbol: proposedTrade.symbol,
          entry_price: proposedTrade.notionalUsd,
          size: 1,
          unrealized_pnl: null,
          side: proposedTrade.side ?? null,
        },
      ]
    : openTrades;

  for (const trade of exposureRows) {
    const entryPrice = Number(trade.entry_price ?? 0);
    const size = Number(trade.size ?? 0);
    const notional = entryPrice * size;
    const unrealizedPnl =
      trade.unrealized_pnl !== null && trade.unrealized_pnl !== undefined
        ? Number(trade.unrealized_pnl)
        : null;

    const existing = symbolMap.get(trade.symbol);
    if (existing) {
      existing.notionalUsd += notional;
      existing.openPositionCount += 1;
      if (unrealizedPnl !== null) {
        existing.unrealizedPnl = (existing.unrealizedPnl ?? 0) + unrealizedPnl;
      }
    } else {
      symbolMap.set(trade.symbol, {
        symbol: trade.symbol,
        notionalUsd: notional,
        unrealizedPnl,
        openPositionCount: 1,
      });
    }
  }

  const exposureBySymbol = Array.from(symbolMap.values()).sort(
    (a, b) => b.notionalUsd - a.notionalUsd,
  );

  // ── Totals ────────────────────────────────────────────────────────────────
  const totalExposureUsd = exposureBySymbol.reduce((s, e) => s + e.notionalUsd, 0);
  const openPositionCount = exposureRows.length;
  const openPositionsBySymbol: Record<string, number> = {};
  for (const [sym, exp] of symbolMap.entries()) {
    openPositionsBySymbol[sym] = exp.openPositionCount;
  }

  // ── Unrealized PnL ────────────────────────────────────────────────────────
  let totalUnrealizedPnl: number | null = null;
  for (const sym of exposureBySymbol) {
    if (sym.unrealizedPnl !== null) {
      totalUnrealizedPnl = (totalUnrealizedPnl ?? 0) + sym.unrealizedPnl;
    }
  }

  // ── Equity / drawdown / daily PnL ─────────────────────────────────────────
  const equityUsd = account !== null ? Number(account.equity ?? 0) : null;
  const startOfDayEquityUsd =
    account !== null
      ? Number(account.start_of_day_equity ?? account.equity ?? 0)
      : null;

  let dailyRealizedPnl: number | null = null;
  if (equityUsd !== null && startOfDayEquityUsd !== null) {
    const unrealized = totalUnrealizedPnl ?? 0;
    dailyRealizedPnl = equityUsd - startOfDayEquityUsd - unrealized;
  }

  let drawdownUsd: number | null = null;
  let drawdownPct: number | null = null;
  if (equityUsd !== null && startOfDayEquityUsd !== null && startOfDayEquityUsd > 0) {
    drawdownUsd = equityUsd - startOfDayEquityUsd;
    drawdownPct = drawdownUsd / startOfDayEquityUsd;
  }

  // Daily risk budget remaining
  let dailyRiskBudgetRemaining: number | null = null;
  if (account !== null) {
    const cap = Number(account.daily_auto_execute_cap_usd ?? 2);
    const lossToday =
      dailyRealizedPnl !== null && dailyRealizedPnl < 0 ? Math.abs(dailyRealizedPnl) : 0;
    dailyRiskBudgetRemaining = Math.max(0, cap - lossToday);
  }

  // ── Correlated group exposure ─────────────────────────────────────────────
  const correlatedExposure: CorrelatedGroupExposure[] = [];
  for (const [group, symbols] of Object.entries(CORRELATED_GROUPS)) {
    const activeSymbols = symbols.filter((s) => symbolMap.has(s));
    const totalNotionalUsd = activeSymbols.reduce(
      (s, sym) => s + (symbolMap.get(sym)?.notionalUsd ?? 0),
      0,
    );
    correlatedExposure.push({ group, symbols, activeSymbols, totalNotionalUsd });
  }

  // ── Rule evaluation ───────────────────────────────────────────────────────

  if (equityUsd !== null && equityUsd > 0) {
    const totalPct = totalExposureUsd / equityUsd;

    if (totalPct >= MAX_TOTAL_EXPOSURE_PCT_BLOCK) {
      blockCodes.push(PORTFOLIO_RISK_CODES.TOTAL_EXPOSURE_BLOCK);
    } else if (totalPct >= MAX_TOTAL_EXPOSURE_PCT_WARN) {
      warningCodes.push(PORTFOLIO_RISK_CODES.TOTAL_EXPOSURE_WARN);
    }

    for (const sym of exposureBySymbol) {
      const pct = sym.notionalUsd / equityUsd;
      if (pct >= MAX_SYMBOL_EXPOSURE_PCT_BLOCK) {
        if (!blockCodes.includes(PORTFOLIO_RISK_CODES.SYMBOL_EXPOSURE_BLOCK)) {
          blockCodes.push(PORTFOLIO_RISK_CODES.SYMBOL_EXPOSURE_BLOCK);
        }
      } else if (pct >= MAX_SYMBOL_EXPOSURE_PCT_WARN) {
        if (!warningCodes.includes(PORTFOLIO_RISK_CODES.SYMBOL_EXPOSURE_WARN)) {
          warningCodes.push(PORTFOLIO_RISK_CODES.SYMBOL_EXPOSURE_WARN);
        }
      }
    }

    for (const group of correlatedExposure) {
      const pct = group.totalNotionalUsd / equityUsd;
      if (pct >= CORRELATED_EXPOSURE_PCT_BLOCK) {
        if (!blockCodes.includes(PORTFOLIO_RISK_CODES.CORRELATED_EXPOSURE_BLOCK)) {
          blockCodes.push(PORTFOLIO_RISK_CODES.CORRELATED_EXPOSURE_BLOCK);
        }
      } else if (pct >= CORRELATED_EXPOSURE_PCT_WARN) {
        if (!warningCodes.includes(PORTFOLIO_RISK_CODES.CORRELATED_EXPOSURE_WARN)) {
          warningCodes.push(PORTFOLIO_RISK_CODES.CORRELATED_EXPOSURE_WARN);
        }
      }
    }

    if (drawdownPct !== null && drawdownPct < -DRAWDOWN_WARN_PCT) {
      warningCodes.push(PORTFOLIO_RISK_CODES.DRAWDOWN_WARN);
    }
  }

  // Open position count
  if (openPositionCount >= MAX_OPEN_POSITIONS_BLOCK) {
    blockCodes.push(PORTFOLIO_RISK_CODES.OPEN_POSITIONS_BLOCK);
  } else if (openPositionCount >= MAX_OPEN_POSITIONS_WARN) {
    warningCodes.push(PORTFOLIO_RISK_CODES.OPEN_POSITIONS_WARN);
  }

  // Duplicate symbol stacking
  for (const count of Object.values(openPositionsBySymbol)) {
    if (count >= DUPLICATE_SYMBOL_WARN_COUNT) {
      if (!warningCodes.includes(PORTFOLIO_RISK_CODES.DUPLICATE_SYMBOL_WARN)) {
        warningCodes.push(PORTFOLIO_RISK_CODES.DUPLICATE_SYMBOL_WARN);
      }
    }
  }

  // Duplicate direction stacking (same-side exposure across multiple open positions)
  const sideCounts = new Map<string, number>();
  for (const trade of exposureRows) {
    if (trade.side === "long" || trade.side === "short") {
      sideCounts.set(trade.side, (sideCounts.get(trade.side) ?? 0) + 1);
    }
  }
  for (const count of sideCounts.values()) {
    if (count >= DUPLICATE_SYMBOL_WARN_COUNT) {
      if (!warningCodes.includes(PORTFOLIO_RISK_CODES.DUPLICATE_DIRECTION_WARN)) {
        warningCodes.push(PORTFOLIO_RISK_CODES.DUPLICATE_DIRECTION_WARN);
      }
    }
  }

  // Daily risk budget low
  if (
    dailyRiskBudgetRemaining !== null &&
    account !== null &&
    Number(account.daily_auto_execute_cap_usd ?? 2) > 0 &&
    dailyRiskBudgetRemaining / Number(account.daily_auto_execute_cap_usd ?? 2) <
      DAILY_RISK_BUDGET_LOW_FRACTION
  ) {
    warningCodes.push(PORTFOLIO_RISK_CODES.DAILY_RISK_BUDGET_LOW);
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  const verdict: PortfolioRiskVerdict =
    blockCodes.length > 0 ? "block" : warningCodes.length > 0 ? "warn" : "clear";

  return {
    verdict,
    warningCodes,
    blockCodes,
    totalExposureUsd,
    exposureBySymbol,
    correlatedExposure,
    openPositionCount,
    openPositionsBySymbol,
    dailyRealizedPnl,
    totalUnrealizedPnl,
    dailyRiskBudgetRemaining,
    equityUsd,
    startOfDayEquityUsd,
    drawdownUsd,
    drawdownPct,
    insufficientData,
    computedAt: new Date(nowMs).toISOString(),
  };
}

/** Safe summary for replay packets — no credentials, no PII. */
export function safePortfolioRiskSummary(summary: PortfolioRiskSummary): Record<string, unknown> {
  return {
    verdict: summary.verdict,
    blockCodes: summary.blockCodes,
    warningCodes: summary.warningCodes,
    totalExposureUsd: summary.totalExposureUsd,
    openPositionCount: summary.openPositionCount,
    equityUsd: summary.equityUsd,
    correlatedExposureSummary: summary.correlatedExposure.map((g) => ({
      group: g.group,
      activeSymbols: g.activeSymbols,
      totalNotionalUsd: g.totalNotionalUsd,
    })),
    insufficientData: summary.insufficientData,
    computedAt: summary.computedAt,
  };
}
