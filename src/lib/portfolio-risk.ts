// ============================================================
// Portfolio-Level Risk Manager — Pure Snapshot
// ------------------------------------------------------------
// No side effects. No DB calls. No trade creation.
// No doctrine mutation. No strategy mutation.
//
// Answers portfolio-level safety questions:
//   - Total exposure vs equity?
//   - Symbol concentration?
//   - Correlated BTC/ETH/SOL exposure?
//   - Daily risk budget remaining?
//   - Drawdown from start-of-day?
//   - Too many open positions?
//   - Duplicate symbol stacking?
//
// Paper mode: warns, degrades; never hard-blocks canTradeNow.
// Live mode:  stricter thresholds; unknown/stale exposure blocks.
// ============================================================

import type { Trade, AccountState, SystemMode } from "./domain-types";

// ─── Correlated symbol groups ────────────────────────────────────────────────

export const CORRELATED_GROUPS: Record<string, string[]> = {
  crypto_major: ["BTC-USD", "ETH-USD", "SOL-USD"],
};

// ─── Thresholds ──────────────────────────────────────────────────────────────

/** Total book exposure / equity — warn */
export const MAX_TOTAL_EXPOSURE_PCT_WARN = 0.3;
/** Total book exposure / equity — block */
export const MAX_TOTAL_EXPOSURE_PCT_BLOCK = 0.5;
/** Single-symbol exposure / equity — warn */
export const MAX_SYMBOL_EXPOSURE_PCT_WARN = 0.2;
/** Single-symbol exposure / equity — block */
export const MAX_SYMBOL_EXPOSURE_PCT_BLOCK = 0.35;
/** Correlated-group exposure / equity — warn */
export const CORRELATED_EXPOSURE_PCT_WARN = 0.25;
/** Correlated-group exposure / equity — block (matches existing BOOK_EXPOSURE_CAP) */
export const CORRELATED_EXPOSURE_PCT_BLOCK = 0.4;
/** Open position count — warn */
export const MAX_OPEN_POSITIONS_WARN = 2;
/** Open position count — hard block */
export const MAX_OPEN_POSITIONS_BLOCK = 3;
/** Daily risk budget remaining fraction — warn when below this */
export const DAILY_RISK_BUDGET_LOW_FRACTION = 0.2;
/** Drawdown from start-of-day equity — warn at this pct (negative) */
export const DRAWDOWN_WARN_PCT = 0.03;
/** How many open positions on the SAME symbol triggers a duplicate warning */
export const DUPLICATE_SYMBOL_WARN_COUNT = 2;

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
  // Blocks
  TOTAL_EXPOSURE_BLOCK: "PORTFOLIO_TOTAL_EXPOSURE_BLOCK",
  SYMBOL_EXPOSURE_BLOCK: "PORTFOLIO_SYMBOL_EXPOSURE_BLOCK",
  CORRELATED_EXPOSURE_BLOCK: "PORTFOLIO_CORRELATED_EXPOSURE_BLOCK",
  OPEN_POSITIONS_BLOCK: "PORTFOLIO_OPEN_POSITIONS_BLOCK",
  // Live-only blocks
  UNKNOWN_EXPOSURE_LIVE_BLOCK: "PORTFOLIO_UNKNOWN_EXPOSURE_LIVE_BLOCK",
} as const;

export type PortfolioRiskCode =
  (typeof PORTFOLIO_RISK_CODES)[keyof typeof PORTFOLIO_RISK_CODES];

// ─── Sub-shapes ───────────────────────────────────────────────────────────────

export interface SymbolExposure {
  symbol: string;
  /** Sum of entry_price × size across all open positions on this symbol */
  notionalUsd: number;
  /** Sum of unrealized_pnl across open positions (null = not yet MTM'd) */
  unrealizedPnl: number | null;
  openPositionCount: number;
}

export interface CorrelatedGroupExposure {
  group: string;
  /** All symbols defined for this group */
  symbols: string[];
  /** Subset of symbols that currently have open positions */
  activeSymbols: string[];
  totalNotionalUsd: number;
}

// ─── Portfolio risk summary ───────────────────────────────────────────────────

export interface PortfolioRiskSummary {
  // Verdict
  verdict: PortfolioRiskVerdict;
  warningCodes: PortfolioRiskCode[];
  blockCodes: PortfolioRiskCode[];

  // Exposure
  totalExposureUsd: number;
  exposureBySymbol: SymbolExposure[];
  correlatedExposure: CorrelatedGroupExposure[];

  // Position counts
  openPositionCount: number;
  openPositionsBySymbol: Record<string, number>;

  // PnL / budget
  dailyRealizedPnl: number | null;
  totalUnrealizedPnl: number | null;
  dailyRiskBudgetRemaining: number | null;

  // Equity / drawdown
  equityUsd: number | null;
  startOfDayEquityUsd: number | null;
  drawdownUsd: number | null;
  drawdownPct: number | null;

  // Data quality
  /** True when account state is unavailable — live mode treats this as a block */
  insufficientData: boolean;

  /** ISO timestamp this snapshot was computed */
  computedAt: string;
}

// ─── Input shape ─────────────────────────────────────────────────────────────

export interface PortfolioRiskInput {
  /** Open trades only (status = 'open'). Caller filters. */
  openTrades: Trade[];
  /** Account state — null when not yet loaded or user has no row */
  account: AccountState | null;
  /** System mode drives paper-vs-live strictness */
  mode: SystemMode | "unknown";
  /** Current time in ms (for testability) */
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
  const insufficientData = account === null;
  if (isLiveMode && insufficientData) {
    blockCodes.push(PORTFOLIO_RISK_CODES.UNKNOWN_EXPOSURE_LIVE_BLOCK);
  }

  // ── Exposure by symbol ────────────────────────────────────────────────────
  const symbolMap = new Map<string, SymbolExposure>();
  for (const trade of openTrades) {
    const notional = trade.entryPrice * trade.size;
    const existing = symbolMap.get(trade.symbol);
    if (existing) {
      existing.notionalUsd += notional;
      existing.openPositionCount += 1;
      if (trade.unrealizedPnl !== null) {
        existing.unrealizedPnl = (existing.unrealizedPnl ?? 0) + trade.unrealizedPnl;
      }
    } else {
      symbolMap.set(trade.symbol, {
        symbol: trade.symbol,
        notionalUsd: notional,
        unrealizedPnl: trade.unrealizedPnl,
        openPositionCount: 1,
      });
    }
  }

  const exposureBySymbol = Array.from(symbolMap.values()).sort(
    (a, b) => b.notionalUsd - a.notionalUsd,
  );

  // ── Totals ────────────────────────────────────────────────────────────────
  const totalExposureUsd = exposureBySymbol.reduce((s, e) => s + e.notionalUsd, 0);
  const openPositionCount = openTrades.length;
  const openPositionsBySymbol: Record<string, number> = {};
  for (const [sym, exp] of symbolMap.entries()) {
    openPositionsBySymbol[sym] = exp.openPositionCount;
  }

  // ── Unrealized PnL ────────────────────────────────────────────────────────
  let totalUnrealizedPnl: number | null = null;
  for (const trade of openTrades) {
    if (trade.unrealizedPnl !== null) {
      totalUnrealizedPnl = (totalUnrealizedPnl ?? 0) + trade.unrealizedPnl;
    }
  }

  // ── Equity / drawdown / daily PnL ─────────────────────────────────────────
  const equityUsd = account?.equity ?? null;
  const startOfDayEquityUsd = account?.startOfDayEquity ?? null;

  let dailyRealizedPnl: number | null = null;
  if (equityUsd !== null && startOfDayEquityUsd !== null) {
    // equity = startOfDay + realized + unrealized (MTM).
    // Subtracting unrealized gives the realized component.
    const unrealized = totalUnrealizedPnl ?? 0;
    dailyRealizedPnl = equityUsd - startOfDayEquityUsd - unrealized;
  }

  let drawdownUsd: number | null = null;
  let drawdownPct: number | null = null;
  if (equityUsd !== null && startOfDayEquityUsd !== null && startOfDayEquityUsd > 0) {
    drawdownUsd = equityUsd - startOfDayEquityUsd;
    drawdownPct = drawdownUsd / startOfDayEquityUsd;
  }

  // Daily risk budget remaining (proxy: dailyAutoExecuteCapUsd minus today's realized losses)
  let dailyRiskBudgetRemaining: number | null = null;
  if (account !== null) {
    const cap = account.dailyAutoExecuteCapUsd;
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

  // Daily risk budget low
  if (
    dailyRiskBudgetRemaining !== null &&
    account !== null &&
    account.dailyAutoExecuteCapUsd > 0 &&
    dailyRiskBudgetRemaining / account.dailyAutoExecuteCapUsd < DAILY_RISK_BUDGET_LOW_FRACTION
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

// ─── Human-readable messages for UI ─────────────────────────────────────────

export function portfolioRiskCodeMessage(
  code: PortfolioRiskCode,
  summary: PortfolioRiskSummary,
): string {
  const equity = summary.equityUsd ?? 0;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  switch (code) {
    case PORTFOLIO_RISK_CODES.TOTAL_EXPOSURE_WARN:
      return `Total book exposure $${summary.totalExposureUsd.toFixed(2)} is over ${pct(MAX_TOTAL_EXPOSURE_PCT_WARN)} of equity — consider reducing.`;
    case PORTFOLIO_RISK_CODES.TOTAL_EXPOSURE_BLOCK:
      return `Total book exposure $${summary.totalExposureUsd.toFixed(2)} exceeds ${pct(MAX_TOTAL_EXPOSURE_PCT_BLOCK)} of equity ($${equity.toFixed(2)}) — portfolio overextended.`;
    case PORTFOLIO_RISK_CODES.SYMBOL_EXPOSURE_WARN: {
      const sym = summary.exposureBySymbol.find(
        (s) => equity > 0 && s.notionalUsd / equity >= MAX_SYMBOL_EXPOSURE_PCT_WARN,
      );
      return `${sym?.symbol ?? "A symbol"} exposure is ${pct((sym?.notionalUsd ?? 0) / equity)} of equity — concentrated position.`;
    }
    case PORTFOLIO_RISK_CODES.SYMBOL_EXPOSURE_BLOCK: {
      const sym = summary.exposureBySymbol.find(
        (s) => equity > 0 && s.notionalUsd / equity >= MAX_SYMBOL_EXPOSURE_PCT_BLOCK,
      );
      return `${sym?.symbol ?? "A symbol"} exposure exceeds ${pct(MAX_SYMBOL_EXPOSURE_PCT_BLOCK)} of equity — single-symbol concentration too high.`;
    }
    case PORTFOLIO_RISK_CODES.CORRELATED_EXPOSURE_WARN: {
      const grp = summary.correlatedExposure.find(
        (g) => equity > 0 && g.totalNotionalUsd / equity >= CORRELATED_EXPOSURE_PCT_WARN,
      );
      return `Correlated exposure (${grp?.activeSymbols.join(", ") ?? "crypto_major"}) is ${pct((grp?.totalNotionalUsd ?? 0) / equity)} of equity.`;
    }
    case PORTFOLIO_RISK_CODES.CORRELATED_EXPOSURE_BLOCK: {
      const grp = summary.correlatedExposure.find(
        (g) => equity > 0 && g.totalNotionalUsd / equity >= CORRELATED_EXPOSURE_PCT_BLOCK,
      );
      return `Correlated exposure (${grp?.activeSymbols.join(", ") ?? "crypto_major"}) exceeds ${pct(CORRELATED_EXPOSURE_PCT_BLOCK)} cap — correlated risk too high.`;
    }
    case PORTFOLIO_RISK_CODES.OPEN_POSITIONS_WARN:
      return `${summary.openPositionCount} open positions — approaching the ${MAX_OPEN_POSITIONS_BLOCK}-position limit.`;
    case PORTFOLIO_RISK_CODES.OPEN_POSITIONS_BLOCK:
      return `${summary.openPositionCount} open positions at or above the ${MAX_OPEN_POSITIONS_BLOCK}-position hard limit.`;
    case PORTFOLIO_RISK_CODES.DAILY_RISK_BUDGET_LOW:
      return `Daily risk budget nearly exhausted — $${(summary.dailyRiskBudgetRemaining ?? 0).toFixed(2)} remaining.`;
    case PORTFOLIO_RISK_CODES.DRAWDOWN_WARN:
      return `Intra-day drawdown ${pct(Math.abs(summary.drawdownPct ?? 0))} from start-of-day equity.`;
    case PORTFOLIO_RISK_CODES.DUPLICATE_SYMBOL_WARN:
      return "Multiple open positions on the same symbol detected — stacking risk.";
    case PORTFOLIO_RISK_CODES.OVERTRADING_WARN:
      return "Overtrading pattern detected — position frequency is elevated.";
    case PORTFOLIO_RISK_CODES.UNKNOWN_EXPOSURE_LIVE_BLOCK:
      return "Live mode: account state unavailable — exposure cannot be verified. All new entries blocked.";
    default:
      return `Portfolio risk: ${code}`;
  }
}
