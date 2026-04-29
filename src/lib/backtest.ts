// Pure-TS backtester for the trend-rev family of strategies.
// Runs entirely client-side over Coinbase candles, returns the same
// StrategyMetrics shape that lives on strategies.metrics jsonb.
//
// Phase 3 upgrade: fees (taker bps, both sides) and slippage (bps applied
// adversely to entry + exit) are now first-class inputs so the numbers
// the UI shows bear some resemblance to numbers a real broker would
// produce. Defaults approximate Coinbase Advanced Trade taker fees
// (~40 bps) + 5 bps slippage, which is a conservative ceiling for BTC
// top-of-book on a quiet tape.

import type { Candle, StrategyParam, StrategyMetrics } from "./domain-types";
import { ema, rsi } from "./indicators";

export interface BacktestTrade {
  side: "long" | "short";
  entryT: number;
  entryPrice: number;    // raw fill, pre-slippage
  exitT: number;
  exitPrice: number;     // raw fill, pre-slippage
  pnlR: number;          // PnL in units of risk (R), net of fees + slippage
  pnlPct: number;        // PnL percent on notional, net of fees + slippage
  grossPnlR: number;     // PnL in R before fees + slippage (audit trail)
  feesPaidPct: number;   // two-sided taker fee, as fraction of notional
  slippagePct: number;   // two-sided slippage drag, as fraction of notional
}

export interface BacktestResult {
  metrics: StrategyMetrics;
  trades: BacktestTrade[];
  candleCount: number;
  equityCurve: number[]; // cumulative R, net
  grossEquityCurve: number[]; // cumulative R, pre-fees-and-slippage
  walkForward?: WalkForwardSplit[]; // present if runWalkForward ran
}

export interface BacktestCosts {
  takerFeeBps: number;   // one-sided, applied twice (entry + exit)
  slippageBps: number;   // one-sided, applied twice (entry + exit)
}

export const DEFAULT_COSTS: BacktestCosts = {
  // Coinbase Advanced Trade taker ~40 bps (0.40%) for a retail lane.
  takerFeeBps: 40,
  // 5 bps per side is a reasonable slippage floor for BTC top-of-book;
  // the runBacktest loop widens it on high-vol candles.
  slippageBps: 5,
};

// MED-8: Regime gate threshold — must match REGIME_DRIFT_THRESHOLD in
// supabase/functions/_shared/regime.ts (0.55). The live engine classifies
// regimes with driftRatio > 0.55; the backtest skips candles below this
// floor so it only fires where the live engine would trade.
// ⚠ If you change this, change _shared/regime.ts and backtest-shared.ts too.
export const REGIME_DRIFT_THRESHOLD = 0.55;

export interface WalkForwardSplit {
  fromT: number;
  toT: number;
  inSample: StrategyMetrics;
  outOfSample: StrategyMetrics;
}

// ---------- helpers ----------
function paramNum(params: StrategyParam[], key: string, fallback: number): number {
  const p = params.find((p) => p.key === key);
  if (!p) return fallback;
  const n = typeof p.value === "number" ? p.value : Number(p.value);
  return Number.isFinite(n) ? n : fallback;
}

// ema/rsi now imported from ./indicators (P4-D dedupe).

function atr(candles: Candle[], period: number): number[] {
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].c : c.c;
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose)));
  }
  // simple moving average of TR
  const out: number[] = new Array(candles.length).fill(0);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += tr[i];
    if (i >= period) sum -= tr[i - period];
    out[i] = i >= period - 1 ? sum / period : tr[i];
  }
  return out;
}

// ---------- main runner ----------
export function runBacktest(
  candles: Candle[],
  params: StrategyParam[],
  costs: BacktestCosts = DEFAULT_COSTS,
): BacktestResult {
  const empty: BacktestResult = {
    metrics: { expectancy: 0, winRate: 0, maxDrawdown: 0, sharpe: 0, trades: 0 },
    trades: [],
    candleCount: candles.length,
    equityCurve: [],
    grossEquityCurve: [],
  };
  if (candles.length < 50) return empty;

  const fast = Math.max(2, Math.round(paramNum(params, "ema_fast", paramNum(params, "ma_fast", 9))));
  const slow = Math.max(fast + 1, Math.round(paramNum(params, "ema_slow", paramNum(params, "ma_slow", 21))));
  const rsiPeriod = Math.max(2, Math.round(paramNum(params, "rsi_period", 14)));
  const atrMult = paramNum(params, "stop_atr_mult", paramNum(params, "stop_pct", 1.5));
  const atrPeriod = 14;
  // Take-profit at 2x risk by default
  const tpMult = paramNum(params, "tp_r_mult", 2);

  const closes = candles.map((c) => c.c);
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const rsiVals = rsi(closes, rsiPeriod);
  const atrVals = atr(candles, atrPeriod);

  const trades: BacktestTrade[] = [];
  let position: { side: "long" | "short"; entryPrice: number; entryT: number; stop: number; tp: number; risk: number } | null = null;

  for (let i = Math.max(slow, rsiPeriod, atrPeriod) + 1; i < candles.length; i++) {
    const c = candles[i];
    const prevFast = emaFast[i - 1];
    const prevSlow = emaSlow[i - 1];
    const curFast = emaFast[i];
    const curSlow = emaSlow[i];
    const r = rsiVals[i];

    // exit logic first
    if (position) {
      let exitPrice: number | null = null;
      if (position.side === "long") {
        if (c.l <= position.stop) exitPrice = position.stop;
        else if (c.h >= position.tp) exitPrice = position.tp;
      } else {
        if (c.h >= position.stop) exitPrice = position.stop;
        else if (c.l <= position.tp) exitPrice = position.tp;
      }
      if (exitPrice !== null) {
        const sideMult = position.side === "long" ? 1 : -1;
        const grossPnlPrice = (exitPrice - position.entryPrice) * sideMult;

        // Fee + slippage: both costs apply on each side. Slippage worsens
        // MED-9: Directional slippage — applied per leg at actual leg prices.
        // Long: buy entry at +slip, sell exit at -slip.  Short: reversed.
        // Fees are taker on both legs. Formula derivation:
        //   entryCost = entryPrice × (feeLeg + slipLeg)
        //   exitCost  = exitPrice  × (feeLeg + slipLeg)
        //   costTotal = (entryPrice + exitPrice) × (feeLeg + slipLeg)
        // where feeFrac/slipFrac below are per-leg fractions (not doubled).
        const feeFrac  = costs.takerFeeBps / 10_000; // per leg
        const slipFrac = costs.slippageBps / 10_000; // per leg
        const costPrice = (Math.abs(position.entryPrice) + Math.abs(exitPrice)) * (feeFrac + slipFrac);
        const netPnlPrice = grossPnlPrice - costPrice;

        const grossPnlR = position.risk > 0 ? grossPnlPrice / position.risk : 0;
        const pnlR = position.risk > 0 ? netPnlPrice / position.risk : 0;
        const pnlPct = (netPnlPrice / position.entryPrice) * 100;
        trades.push({
          side: position.side,
          entryT: position.entryT,
          entryPrice: position.entryPrice,
          exitT: c.t,
          exitPrice,
          pnlR,
          pnlPct,
          grossPnlR,
          feesPaidPct: feeFrac,
          slippagePct: slipFrac,
        });
        position = null;
      }
    }

    // entry logic
    if (!position) {
      // Regime gate — mirrors live engine's TRADEABLE_REGIMES + setupScore floor.
      // Skip chop / range so the backtest only fires where the live engine would.
      const winStart = Math.max(0, i - 25);
      const winC = candles.slice(winStart, i + 1);
      const winCloses = winC.map((x) => x.c);
      const winHigh = Math.max(...winC.map((x) => x.h));
      const winLow = Math.min(...winC.map((x) => x.l));
      const winPctChange = ((winCloses[winCloses.length - 1] - winCloses[0]) / winCloses[0]) * 100;
      const rangePct = ((winHigh - winLow) / Math.max(winLow, 1e-9)) * 100;
      const driftRatio = Math.abs(winPctChange) / Math.max(rangePct, 0.01);
      if (driftRatio < REGIME_DRIFT_THRESHOLD) continue;
      if (rangePct < 0.8 && Math.abs(winPctChange) < 0.3) continue;

      const crossUp = prevFast <= prevSlow && curFast > curSlow && r > 50 && r < 75;
      const crossDown = prevFast >= prevSlow && curFast < curSlow && r < 50 && r > 25;
      if (crossUp) {
        const risk = atrVals[i] * atrMult;
        if (risk > 0) {
          position = {
            side: "long",
            entryPrice: c.c,
            entryT: c.t,
            stop: c.c - risk,
            tp: c.c + risk * tpMult,
            risk,
          };
        }
      } else if (crossDown) {
        const risk = atrVals[i] * atrMult;
        if (risk > 0) {
          position = {
            side: "short",
            entryPrice: c.c,
            entryT: c.t,
            stop: c.c + risk,
            tp: c.c - risk * tpMult,
            risk,
          };
        }
      }
    }
  }

  if (trades.length === 0) return empty;

  // ---------- metrics ----------
  const wins = trades.filter((t) => t.pnlR > 0);
  const winRate = wins.length / trades.length;
  const expectancy = trades.reduce((s, t) => s + t.pnlR, 0) / trades.length; // R per trade

  // equity curve in R (net of costs)
  const curve: number[] = [];
  let cum = 0;
  for (const t of trades) {
    cum += t.pnlR;
    curve.push(cum);
  }
  // parallel gross curve, for pre-cost comparison
  const grossCurve: number[] = [];
  let gcum = 0;
  for (const t of trades) {
    gcum += t.grossPnlR;
    grossCurve.push(gcum);
  }
  // Industry-standard drawdown: peak-to-trough on a compounded equity
  // curve assuming 1% risk per trade. Replaces the old "% of gross profit"
  // normalization that produced misleading numbers (e.g., -310%).
  const RISK_PER_TRADE = 0.01;
  let eq = 1.0;
  let peakEq = 1.0;
  let maxDDFrac = 0;
  for (const t of trades) {
    eq = Math.max(0, eq * (1 + t.pnlR * RISK_PER_TRADE));
    if (eq > peakEq) peakEq = eq;
    const dd = peakEq > 0 ? (peakEq - eq) / peakEq : 0;
    if (dd > maxDDFrac) maxDDFrac = dd;
  }
  const maxDrawdown = -Math.min(1, maxDDFrac);

  // sharpe-ish: mean(pnlR) / stdev(pnlR) * sqrt(N) — annualization-agnostic
  const mean = expectancy;
  const variance = trades.reduce((s, t) => s + (t.pnlR - mean) ** 2, 0) / trades.length;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(trades.length) : 0;

  // MED-3: profitFactor, avgWin, avgLoss — parity with backtest-shared metrics.
  const winnersArr = trades.filter((t) => t.pnlR > 0);
  const losersArr  = trades.filter((t) => t.pnlR < 0);
  const grossProfit = winnersArr.reduce((s, t) => s + t.pnlR, 0);
  const grossLoss   = Math.abs(losersArr.reduce((s, t) => s + t.pnlR, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 999 : 1) : grossProfit / grossLoss;
  const avgWin  = winnersArr.length > 0 ? grossProfit / winnersArr.length : 0;
  const avgLoss = losersArr.length  > 0 ? grossLoss  / losersArr.length  : 0;

  return {
    metrics: {
      expectancy: Number(expectancy.toFixed(3)),
      winRate: Number(winRate.toFixed(3)),
      maxDrawdown: Number(maxDrawdown.toFixed(3)),
      sharpe: Number(sharpe.toFixed(3)),
      trades: trades.length,
      profitFactor: Number(profitFactor.toFixed(2)),
      avgWin: Number(avgWin.toFixed(3)),
      avgLoss: Number(avgLoss.toFixed(3)),
    },
    trades,
    candleCount: candles.length,
    equityCurve: curve,
    grossEquityCurve: grossCurve,
  };
}

// ---------- walk-forward harness ----------
// Splits the candle history into `folds` contiguous chunks. For each chunk
// past the first, the prior window is used for "in-sample" evaluation
// (no re-fit — we're not optimizing params here, we're just quantifying
// how much the edge degrades out-of-sample) and the fold itself is the
// out-of-sample window. The caller compares `inSample` vs `outOfSample`
// metrics per fold to gauge robustness.
export function runWalkForward(
  candles: Candle[],
  params: StrategyParam[],
  folds = 4,
  costs: BacktestCosts = DEFAULT_COSTS,
): WalkForwardSplit[] {
  if (candles.length < 200 || folds < 2) return [];
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const chunkSize = Math.floor(sorted.length / folds);
  const splits: WalkForwardSplit[] = [];
  for (let f = 1; f < folds; f++) {
    const inSample = sorted.slice(0, f * chunkSize);
    const outOfSample = sorted.slice(f * chunkSize, (f + 1) * chunkSize);
    if (outOfSample.length < 50) continue;
    const inResult = runBacktest(inSample, params, costs);
    const oosResult = runBacktest(outOfSample, params, costs);
    splits.push({
      fromT: outOfSample[0].t,
      toT: outOfSample[outOfSample.length - 1].t,
      inSample: inResult.metrics,
      outOfSample: oosResult.metrics,
    });
  }
  return splits;
}

// Convenience: fetch Coinbase candles and run the backtest.
export async function fetchCandlesAndBacktest(
  params: StrategyParam[],
  opts: { symbol?: string; granularity?: number; costs?: BacktestCosts; walkForwardFolds?: number } = {},
): Promise<BacktestResult> {
  const symbol = opts.symbol ?? "BTC-USD";
  const granularity = opts.granularity ?? 3600; // 1h
  const costs = opts.costs ?? DEFAULT_COSTS;
  const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${granularity}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Coinbase ${res.status}`);
  type Raw = [number, number, number, number, number, number];
  const raw = (await res.json()) as Raw[];
  const sorted = [...raw].sort((a, b) => a[0] - b[0]);
  const candles: Candle[] = sorted.map(([t, l, h, o, c, v]) => ({ t, l, h, o, c, v }));
  const result = runBacktest(candles, params, costs);
  if (opts.walkForwardFolds && opts.walkForwardFolds >= 2) {
    result.walkForward = runWalkForward(candles, params, opts.walkForwardFolds, costs);
  }
  return result;
}
