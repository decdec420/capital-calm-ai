// ============================================================
// Regime Detection (Authoritative)
// ------------------------------------------------------------
// Authoritative. Browser reads from this; never forks.
// Unifies the richer Lovable edge-function version (with
// pullback detection) and the backend Trader classification.
// Exports a single computeRegime() used by signal-engine,
// mark-to-market, and the browser src/lib/regime.ts wrapper.
// ============================================================

import type { Candle } from "./market.ts";

export type RegimeLabel =
  | "trending_up"
  | "trending_down"
  | "range"
  | "chop"
  | "breakout"
  | "no_trade";

// MED-8: Single source of truth for the trending-regime drift threshold.
// Import this in backtest-shared.ts and src/lib/backtest.ts so all three
// paths agree on when a market is 'trending enough' to trade.
export const REGIME_DRIFT_THRESHOLD = 0.55;

export type VolatilityState = "low" | "normal" | "elevated" | "extreme";

export interface RegimeResult {
  regime: RegimeLabel;
  confidence: number; // 0..1
  volatility: VolatilityState;
  setupScore: number; // 0..1
  todScore: number; // 0..1 — time-of-day liquidity score
  pctChange: number;
  annualizedVolPct: number;
  pullback: boolean;
  rsiNow: number;
  rsiPrev: number;
  emaFast: number;
  emaSlow: number;
  slowRising: boolean;
  noTradeReasons: string[];
}

export const TRADEABLE_REGIMES: ReadonlySet<RegimeLabel> = new Set<RegimeLabel>([
  "trending_up",
  "trending_down",
  "breakout",
]);

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[i] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  const avgG = gains / period;
  const avgL = losses / period;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

export function sma(values: number[], length: number): number | null {
  if (values.length < length) return null;
  const tail = values.slice(-length);
  const sum = tail.reduce((a, b) => a + b, 0);
  return sum / length;
}

export interface RegimeOpts {
  nowIso?: string;
  /** Fast EMA period (defaults to 9). Comes from the approved strategy's
   * `ema_fast` param so changing the strategy actually changes the live
   * regime detection — not just the backtest. */
  emaFast?: number;
  /** Slow EMA period (defaults to 21). Source: strategy `ema_slow`. */
  emaSlow?: number;
  /** RSI lookback (defaults to 14). Source: strategy `rsi_period`. */
  rsiPeriod?: number;
}

export function computeRegime(
  candles: Candle[],
  opts: RegimeOpts = {},
): RegimeResult {
  const fastP = Math.max(2, Math.round(opts.emaFast ?? 9));
  const slowP = Math.max(fastP + 1, Math.round(opts.emaSlow ?? 21));
  const rsiP = Math.max(2, Math.round(opts.rsiPeriod ?? 14));
  const fallback: RegimeResult = {
    regime: "no_trade",
    confidence: 0,
    volatility: "normal",
    setupScore: 0,
    todScore: 0.5,
    pctChange: 0,
    annualizedVolPct: 0,
    pullback: false,
    rsiNow: 50,
    rsiPrev: 50,
    emaFast: 0,
    emaSlow: 0,
    slowRising: false,
    noTradeReasons: ["Not enough data"],
  };

  if (candles.length < 25) return fallback;

  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1];
  const first = closes[0];
  const pctChange = ((last - first) / first) * 100;

  // Volatility
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const stdev = Math.sqrt(variance);
  const annualizedVolPct = stdev * Math.sqrt(24 * 365) * 100;
  let volatility: VolatilityState = "normal";
  if (annualizedVolPct < 30) volatility = "low";
  else if (annualizedVolPct > 80) volatility = "elevated";
  if (annualizedVolPct > 140) volatility = "extreme";

  // Structural classification
  const high = Math.max(...candles.map((c) => c.h));
  const low = Math.min(...candles.map((c) => c.l));
  const rangePct = ((high - low) / low) * 100;
  const driftRatio = Math.abs(pctChange) / Math.max(rangePct, 0.01);
  let regime: RegimeLabel = "range";
  if (driftRatio > REGIME_DRIFT_THRESHOLD) regime = pctChange > 0 ? "trending_up" : "trending_down"; // MED-8
  else if (rangePct < 0.8) regime = "chop";

  const prior20High = Math.max(...candles.slice(-21, -1).map((c) => c.h));
  if (last > prior20High * 1.001) regime = "breakout";

  const confidence = Math.min(1, Math.max(0.25, driftRatio * 1.2));

  // Time of day (UTC)
  const now = opts.nowIso ? new Date(opts.nowIso) : new Date();
  const hour = now.getUTCHours();
  const todScore =
    hour >= 13 && hour < 21 ? 0.85 : hour >= 7 && hour < 23 ? 0.55 : 0.3;

  const trendBoost =
    regime === "trending_up" || regime === "breakout"
      ? 0.25
      : regime === "trending_down"
        ? 0.1
        : 0;
  const volBoost = volatility === "normal" ? 0.2 : volatility === "low" ? 0.05 : 0;

  // Pullback detection (buy-the-dip inside an uptrend) — uses strategy params.
  const emaFastArr = ema(closes, fastP);
  const emaSlowArr = ema(closes, slowP);
  const emaFast = emaFastArr[emaFastArr.length - 1];
  const emaSlow = emaSlowArr[emaSlowArr.length - 1];
  const emaSlowPrev = emaSlowArr[emaSlowArr.length - 6] ?? emaSlow;
  const slowRising = emaSlow > emaSlowPrev;
  const rsiNow = rsi(closes, rsiP);
  const rsiPrev = rsi(closes.slice(0, -1), rsiP);
  const recent = candles.slice(-3);
  const touchedFastEma = recent.some((c) => c.l <= emaFast * 1.004);
  const inUptrend = (regime === "trending_up" || regime === "breakout") && slowRising;
  const rsiCurlingUp = rsiPrev < 45 && rsiNow > rsiPrev && rsiNow < 65;
  const pullback = inUptrend && touchedFastEma && rsiCurlingUp;

  const pullbackBoost = pullback ? 0.2 : 0;
  const setupScore = Math.min(
    1,
    Math.max(
      0,
      confidence * 0.35 +
        todScore * 0.25 +
        trendBoost +
        volBoost +
        pullbackBoost,
    ),
  );

  const noTradeReasons: string[] = [];
  // Threshold aligned with signal-engine's MIN_SETUP_SCORE (0.55 live, 0.45 paper).
  // Previously 0.65 here vs 0.55 in the engine — the AI was reading the higher
  // advisory and skipping trades the code gate would have passed.
  if (setupScore < 0.55) {
    noTradeReasons.push(`Setup score ${setupScore.toFixed(2)} below 0.55`);
  }
  if (volatility === "extreme") noTradeReasons.push("Volatility extreme");
  if (regime === "chop" || regime === "range") {
    noTradeReasons.push(`${regime} regime — no edge`);
  }
  if (todScore < 0.4) noTradeReasons.push("Outside prime liquidity window");

  return {
    regime,
    confidence,
    volatility,
    setupScore,
    todScore,
    pctChange,
    annualizedVolPct,
    pullback,
    rsiNow,
    rsiPrev,
    emaFast,
    emaSlow,
    slowRising,
    noTradeReasons,
  };
}
