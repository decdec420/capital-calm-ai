// Pure-TS backtester for the trend-rev family of strategies.
// Runs entirely client-side over Coinbase candles, returns the same
// StrategyMetrics shape that lives on strategies.metrics jsonb.

import type { Candle, StrategyParam, StrategyMetrics } from "./domain-types";

export interface BacktestTrade {
  side: "long" | "short";
  entryT: number;
  entryPrice: number;
  exitT: number;
  exitPrice: number;
  pnlR: number; // PnL in units of risk (R)
  pnlPct: number;
}

export interface BacktestResult {
  metrics: StrategyMetrics;
  trades: BacktestTrade[];
  candleCount: number;
  equityCurve: number[]; // cumulative R
}

// ---------- helpers ----------
function paramNum(params: StrategyParam[], key: string, fallback: number): number {
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
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
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
export function runBacktest(candles: Candle[], params: StrategyParam[]): BacktestResult {
  const empty: BacktestResult = {
    metrics: { expectancy: 0, winRate: 0, maxDrawdown: 0, sharpe: 0, trades: 0 },
    trades: [],
    candleCount: candles.length,
    equityCurve: [],
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
        const pnlPrice = (exitPrice - position.entryPrice) * sideMult;
        const pnlR = position.risk > 0 ? pnlPrice / position.risk : 0;
        const pnlPct = (pnlPrice / position.entryPrice) * 100;
        trades.push({
          side: position.side,
          entryT: position.entryT,
          entryPrice: position.entryPrice,
          exitT: c.t,
          exitPrice,
          pnlR,
          pnlPct,
        });
        position = null;
      }
    }

    // entry logic
    if (!position) {
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

  // equity curve in R
  const curve: number[] = [];
  let cum = 0;
  for (const t of trades) {
    cum += t.pnlR;
    curve.push(cum);
  }
  // max drawdown (in R, expressed as a percentage of peak)
  let peak = 0;
  let maxDD = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }
  // Express maxDrawdown as a negative fraction (e.g. -0.05 = -5%) using
  // peak-to-trough R as a share of total positive R, capped to keep it sane.
  const totalUp = trades.filter((t) => t.pnlR > 0).reduce((s, t) => s + t.pnlR, 0);
  const maxDrawdown = totalUp > 0 ? -Math.min(1, maxDD / totalUp) : 0;

  // sharpe-ish: mean(pnlR) / stdev(pnlR) * sqrt(N) — annualization-agnostic
  const mean = expectancy;
  const variance = trades.reduce((s, t) => s + (t.pnlR - mean) ** 2, 0) / trades.length;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(trades.length) : 0;

  return {
    metrics: {
      expectancy: Number(expectancy.toFixed(3)),
      winRate: Number(winRate.toFixed(3)),
      maxDrawdown: Number(maxDrawdown.toFixed(3)),
      sharpe: Number(sharpe.toFixed(3)),
      trades: trades.length,
    },
    trades,
    candleCount: candles.length,
    equityCurve: curve,
  };
}

// Convenience: fetch Coinbase candles and run the backtest.
export async function fetchCandlesAndBacktest(
  params: StrategyParam[],
  opts: { symbol?: string; granularity?: number } = {},
): Promise<BacktestResult> {
  const symbol = opts.symbol ?? "BTC-USD";
  const granularity = opts.granularity ?? 3600; // 1h
  const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${granularity}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Coinbase ${res.status}`);
  type Raw = [number, number, number, number, number, number];
  const raw = (await res.json()) as Raw[];
  const sorted = [...raw].sort((a, b) => a[0] - b[0]);
  const candles: Candle[] = sorted.map(([t, l, h, o, c, v]) => ({ t, l, h, o, c, v }));
  return runBacktest(candles, params);
}
