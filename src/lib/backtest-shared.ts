// Pure backtest core, runtime-agnostic (works in Deno + browser).
// Lives here so the run-experiment edge function and the client can share
// EXACTLY the same numbers. No DOM, no Node, no Deno imports.

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
  pnlR: number;
  pnlPct: number;
}
export interface SharedBacktestResult {
  metrics: SharedMetrics;
  trades: SharedTrade[];
  candleCount: number;
  equityCurve: number[];
  // Sample stdev of pnlR — used by the run-experiment significance check.
  pnlRStdev: number;
}

function paramNum(params: SharedParam[], key: string, fallback: number): number {
  const p = params.find((p) => p.key === key);
  if (!p) return fallback;
  const n = typeof p.value === "number" ? p.value : Number(p.value);
  return Number.isFinite(n) ? n : fallback;
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

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
        const pnlR = position.risk > 0 ? pnlPrice / position.risk : 0;
        const pnlPct = (pnlPrice / position.entryPrice) * 100;
        trades.push({ side: position.side, entryT: position.entryT, entryPrice: position.entryPrice, exitT: c.t, exitPrice, pnlR, pnlPct });
        position = null;
      }
    }

    if (!position) {
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

  // Industry-standard drawdown: peak-to-trough on a compounded equity
  // curve assuming 1% risk per trade. Old version normalized against
  // gross profits and produced misleading numbers like -310%.
  const RISK_PER_TRADE = 0.01;
  const equityCurve: number[] = [];
  let equity = 1.0;
  for (const t of trades) {
    equity = Math.max(0, equity * (1 + t.pnlR * RISK_PER_TRADE));
    equityCurve.push(equity);
  }
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
    pnlRStdev: Number(stdev.toFixed(4)),
  };
}
