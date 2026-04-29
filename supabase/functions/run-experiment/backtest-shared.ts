// Pure backtest core, runtime-agnostic (works in Deno + browser).
// Lives here so the run-experiment edge function and the client can share
// EXACTLY the same numbers. No DOM, no Node, no Deno imports.

// P4-D: `ema` is canonical in ../_shared/regime.ts (same array signature).
// `rsi` stays local because regime.ts's `rsi` returns a single scalar
// (last-value), while the backtester needs an array aligned to `values`.
import { ema, REGIME_DRIFT_THRESHOLD } from "../_shared/regime.ts";

// Transaction-cost model — keep in sync with src/lib/backtest.ts DEFAULT_COSTS.
// Two taker legs (entry + exit) + two slippage legs.
const TAKER_FEE_BPS = 40;  // 40 bps per leg
const SLIPPAGE_BPS   =  5;  //  5 bps per leg

export interface SharedCandle { t: number; o: number; h: number; l: number; c: number; v: number }
export interface SharedParam { key: string; value: number | string | boolean; unit?: string }
export interface SharedMetrics {
  expectancy: number;
  winRate: number;
  maxDrawdown: number;
  sharpe: number;
  trades: number;
  /** Gross profit / gross loss in R. 999 sentinel when there are no losses. */
  profitFactor: number;
  /** Average winning trade in R. */
  avgWin: number;
  /** Average losing trade magnitude in R (positive number). */
  avgLoss: number;
}
export interface SharedTrade {
  side: "long" | "short";
  entryT: number;
  entryPrice: number;
  exitT: number;
  exitPrice: number;
  /** Net P&L in R units (after fees + slippage). This is what the metrics are built on. */
  pnlR: number;
  /** Gross P&L in R units (before fees + slippage). */
  grossPnlR: number;
  pnlPct: number;
  /** Round-trip taker fees as % of notional (both legs). */
  feesPaidPct: number;
  /** Round-trip slippage as % of notional (both legs). */
  slippagePct: number;
}
export interface SharedBacktestResult {
  metrics: SharedMetrics;
  trades: SharedTrade[];
  candleCount: number;
  equityCurve: number[];
  /** Equity curve before fee/slippage deduction — shows cost drag vs gross. */
  grossEquityCurve: number[];
  // Sample stdev of pnlR (net) — used by the run-experiment significance check.
  pnlRStdev: number;
}

function paramNum(params: SharedParam[], key: string, fallback: number): number {
  const p = params.find((p) => p.key === key);
  if (!p) return fallback;
  const n = typeof p.value === "number" ? p.value : Number(p.value);
  return Number.isFinite(n) ? n : fallback;
}

// ema now imported from ../_shared/regime.ts (P4-D dedupe).

function rsi(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(50);
  if (values.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgG = gains / period;
  let avgL = losses / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function atr(candles: SharedCandle[], period: number): number[] {
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].c : c.c;
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose)));
  }
  const out: number[] = new Array(candles.length).fill(0);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += tr[i];
    if (i >= period) sum -= tr[i - period];
    out[i] = i >= period - 1 ? sum / period : tr[i];
  }
  return out;
}

export function runSharedBacktest(candles: SharedCandle[], params: SharedParam[]): SharedBacktestResult {
  const empty: SharedBacktestResult = {
    metrics: { expectancy: 0, winRate: 0, maxDrawdown: 0, sharpe: 0, trades: 0, profitFactor: 0, avgWin: 0, avgLoss: 0 },
    trades: [],
    candleCount: candles.length,
    equityCurve: [],
    grossEquityCurve: [],
    pnlRStdev: 0,
  };
  if (candles.length < 50) return empty;

  const fast = Math.max(2, Math.round(paramNum(params, "ema_fast", paramNum(params, "ma_fast", 9))));
  const slow = Math.max(fast + 1, Math.round(paramNum(params, "ema_slow", paramNum(params, "ma_slow", 21))));
  const rsiPeriod = Math.max(2, Math.round(paramNum(params, "rsi_period", 14)));
  const atrMult = paramNum(params, "stop_atr_mult", paramNum(params, "stop_pct", 1.5));
  const atrPeriod = 14;
  const tpMult = paramNum(params, "tp_r_mult", 2);

  const closes = candles.map((c) => c.c);
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const rsiVals = rsi(closes, rsiPeriod);
  const atrVals = atr(candles, atrPeriod);

  const trades: SharedTrade[] = [];
  let position: { side: "long" | "short"; entryPrice: number; entryT: number; stop: number; tp: number; risk: number } | null = null;

  for (let i = Math.max(slow, rsiPeriod, atrPeriod) + 1; i < candles.length; i++) {
    const c = candles[i];
    const prevFast = emaFast[i - 1];
    const prevSlow = emaSlow[i - 1];
    const curFast = emaFast[i];
    const curSlow = emaSlow[i];
    const r = rsiVals[i];

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
        const pnlPrice = (exitPrice - position.entryPrice) * sideMult;
        const grossPnlR = position.risk > 0 ? pnlPrice / position.risk : 0;
        const pnlPct = (pnlPrice / position.entryPrice) * 100;
        // MED-9: Directional cost model — applied at actual per-leg prices.
        // Long: overpay entry (+slip), undersell exit (-slip). Short: reversed.
        // Total = (entryPrice + exitPrice) × (feePerLeg + slipPerLeg)
        const feesPaidPct  = (TAKER_FEE_BPS * 2) / 100;  // round-trip % for UI display
        const slippagePct  = (SLIPPAGE_BPS  * 2) / 100;  // round-trip % for UI display
        const feePerLeg    = TAKER_FEE_BPS / 10_000;
        const slipPerLeg   = SLIPPAGE_BPS  / 10_000;
        const costPrice    = (position.entryPrice + exitPrice) * (feePerLeg + slipPerLeg);
        const costR        = position.risk > 0 ? costPrice / position.risk : 0;
        const pnlR         = grossPnlR - costR;
        trades.push({
          side: position.side,
          entryT: position.entryT, entryPrice: position.entryPrice,
          exitT: c.t, exitPrice,
          pnlR, grossPnlR, pnlPct, feesPaidPct, slippagePct,
        });
        position = null;
      }
    }

    if (!position) {
      // ── Regime gate ──────────────────────────────────────────────
      // Live engine only fires in trending_up / trending_down / breakout
      // and requires setupScore ≥ 0.55. Without a regime gate the
      // backtest happily takes EMA crosses inside chop the live engine
      // would refuse — and we then "learn" from trades that never
      // would have happened. Mirror computeRegime's 25-candle window
      // and skip when drift is weak or the range is pure noise.
      const winStart = Math.max(0, i - 25);
      const winC = candles.slice(winStart, i + 1);
      const winCloses = winC.map((x) => x.c);
      const winHigh = Math.max(...winC.map((x) => x.h));
      const winLow = Math.min(...winC.map((x) => x.l));
      const winPctChange = ((winCloses[winCloses.length - 1] - winCloses[0]) / winCloses[0]) * 100;
      const rangePct = ((winHigh - winLow) / Math.max(winLow, 1e-9)) * 100;
      const driftRatio = Math.abs(winPctChange) / Math.max(rangePct, 0.01);
      if (driftRatio < REGIME_DRIFT_THRESHOLD) continue; // MED-8: matches live engine threshold
      if (rangePct < 0.8 && Math.abs(winPctChange) < 0.3) continue;

      const crossUp = prevFast <= prevSlow && curFast > curSlow && r > 50 && r < 75;
      const crossDown = prevFast >= prevSlow && curFast < curSlow && r < 50 && r > 25;
      if (crossUp) {
        const risk = atrVals[i] * atrMult;
        if (risk > 0) position = { side: "long", entryPrice: c.c, entryT: c.t, stop: c.c - risk, tp: c.c + risk * tpMult, risk };
      } else if (crossDown) {
        const risk = atrVals[i] * atrMult;
        if (risk > 0) position = { side: "short", entryPrice: c.c, entryT: c.t, stop: c.c + risk, tp: c.c - risk * tpMult, risk };
      }
    }
  }

  if (trades.length === 0) return empty;

  const wins = trades.filter((t) => t.pnlR > 0);
  const winRate = wins.length / trades.length;
  const expectancy = trades.reduce((s, t) => s + t.pnlR, 0) / trades.length;

  // ───── Industry-standard drawdown ─────────────────────────────
  // Old version normalized peak-to-trough R against gross profits, which
  // produced misleading numbers like -310% (a strategy with 1R total
  // profit and a 3.1R losing streak). The standard definition is:
  //   maxDD = max over time of (peak_equity - current_equity) / peak_equity
  // We assume a fixed risk-per-trade of 1% of equity (the classic
  // "risk 1R = 1% of account" convention). The compounded equity curve
  // mirrors what a real account would do; the resulting drawdown is a
  // negative fraction in [-1, 0] like the rest of the codebase expects.
  const RISK_PER_TRADE = 0.01;
  const equityCurve: number[] = [];
  const grossEquityCurve: number[] = [];
  let equity = 1.0;
  let grossEquity = 1.0;
  for (const t of trades) {
    equity      = Math.max(0, equity      * (1 + t.pnlR      * RISK_PER_TRADE));
    grossEquity = Math.max(0, grossEquity * (1 + t.grossPnlR * RISK_PER_TRADE));
    equityCurve.push(equity);
    grossEquityCurve.push(grossEquity);
  }
  // Cumulative-R curve (kept for charts and the OOS expectancy delta).
  const curve: number[] = [];
  let cum = 0;
  for (const t of trades) { cum += t.pnlR; curve.push(cum); }

  let peakEq = 1.0;
  let maxDDFrac = 0;
  for (const v of equityCurve) {
    if (v > peakEq) peakEq = v;
    const dd = peakEq > 0 ? (peakEq - v) / peakEq : 0;
    if (dd > maxDDFrac) maxDDFrac = dd;
  }
  const maxDrawdown = -Math.min(1, maxDDFrac);

  const mean = expectancy;
  const variance = trades.reduce((s, t) => s + (t.pnlR - mean) ** 2, 0) / trades.length;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(trades.length) : 0;

  // Profit factor + average win/loss — useful tells for over-fit results
  // (huge expectancy from one big winner shows up as profitFactor close to 1).
  const winnersArr = trades.filter((t) => t.pnlR > 0);
  const losersArr = trades.filter((t) => t.pnlR < 0);
  const grossProfit = winnersArr.reduce((s, t) => s + t.pnlR, 0);
  const grossLoss = Math.abs(losersArr.reduce((s, t) => s + t.pnlR, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 999 : 1) : grossProfit / grossLoss;
  const avgWin = winnersArr.length > 0 ? grossProfit / winnersArr.length : 0;
  const avgLoss = losersArr.length > 0 ? grossLoss / losersArr.length : 0;

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
    grossEquityCurve,
    pnlRStdev: Number(stdev.toFixed(4)),
  };
}
