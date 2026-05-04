// ============================================================
// Browser-side regime computation
// ------------------------------------------------------------
// Kept in sync with supabase/functions/_shared/regime.ts.
// Pure function — no I/O. Used by the Market Intel page to
// show live candle-derived regime alongside Brain Trust data.
//
// KEY INVARIANT: the formula, thresholds, and field names here
// must match the server version. If you change one, change both.
// ============================================================

import type { Candle, MarketRegime, Regime, SpreadQuality, VolatilityState } from "./domain-types";

// Single source of truth — matches server REGIME_DRIFT_THRESHOLD.
export const REGIME_DRIFT_THRESHOLD = 0.55;

// Live threshold the engine uses (paper is 0.45).
export const MIN_SETUP_SCORE_LIVE = 0.55;

// ── Helpers ───────────────────────────────────────────────────

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[i] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(values: number[], period = 14): number {
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
  return 100 - 100 / (1 + avgG / avgL);
}

// ── Main export ───────────────────────────────────────────────

/** Compute a market regime from raw candles. Pure function — no I/O. */
export function computeRegime(
  symbol: string,
  candles: Candle[],
  opts: { emaFastP?: number; emaSlowP?: number; rsiP?: number } = {},
): MarketRegime {
  const fastP = Math.max(2, Math.round(opts.emaFastP ?? 9));
  const slowP = Math.max(fastP + 1, Math.round(opts.emaSlowP ?? 21));
  const rsiP  = Math.max(2, Math.round(opts.rsiP ?? 14));

  const fallback: MarketRegime = {
    symbol,
    regime: "range",
    confidence: 0,
    volatility: "normal",
    spread: "tight",
    timeOfDayScore: 0.5,
    setupScore: 0,
    noTradeReasons: ["Not enough data — waiting for fresh candles."],
    summary: "Calibrating on the latest tape — no trades until there's a real read.",
    rsiNow: 50,
    rsiPrev: 50,
    emaFast: 0,
    emaSlow: 0,
    slowRising: false,
    pullback: false,
    annualizedVolPct: 0,
    pctChange: 0,
    rsiOverbought: false,
    rsiOversold: false,
  };

  if (candles.length < 25) return fallback;

  const closes = candles.map((c) => c.c);
  const last  = closes[closes.length - 1];
  const first = closes[0];
  const pctChange = ((last - first) / first) * 100;

  // ── Volatility ────────────────────────────────────────────
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++)
    rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const stdev = Math.sqrt(variance);
  const annualizedVolPct = stdev * Math.sqrt(24 * 365) * 100;

  let volatility: VolatilityState = "normal";
  if (annualizedVolPct < 30)  volatility = "low";
  else if (annualizedVolPct > 80) volatility = "elevated";
  if (annualizedVolPct > 140) volatility = "extreme";

  // ── Structural classification ─────────────────────────────
  const high = Math.max(...candles.map((c) => c.h));
  const low  = Math.min(...candles.map((c) => c.l));
  const rangePct  = ((high - low) / low) * 100;
  const driftRatio = Math.abs(pctChange) / Math.max(rangePct, 0.01);

  let regime: Regime = "range";
  if (driftRatio > REGIME_DRIFT_THRESHOLD)
    regime = pctChange > 0 ? "trending_up" : "trending_down";
  else if (rangePct < 0.8) regime = "chop";

  const prior20High = Math.max(...candles.slice(-21, -1).map((c) => c.h));
  if (last > prior20High * 1.001) regime = "breakout";

  const confidence = Math.min(1, Math.max(0.25, driftRatio * 1.2));

  // ── Spread (estimated from vol) ───────────────────────────
  const spread: SpreadQuality =
    volatility === "extreme" ? "wide" : volatility === "elevated" ? "normal" : "tight";

  // ── Time-of-day score (UTC) ───────────────────────────────
  const hour = new Date().getUTCHours();
  const todScore =
    hour >= 13 && hour < 21 ? 0.85 : hour >= 7 && hour < 23 ? 0.55 : 0.3;

  // ── EMA / RSI ─────────────────────────────────────────────
  const emaFastArr = ema(closes, fastP);
  const emaSlowArr = ema(closes, slowP);
  const emaFastVal = emaFastArr[emaFastArr.length - 1];
  const emaSlowVal = emaSlowArr[emaSlowArr.length - 1];
  const emaSlowPrev = emaSlowArr[emaSlowArr.length - 6] ?? emaSlowVal;
  const slowRising = emaSlowVal > emaSlowPrev;

  const rsiNow  = rsi(closes, rsiP);
  const rsiPrev = rsi(closes.slice(0, -1), rsiP);

  // ── Pullback detection (matches server logic) ─────────────
  const recent = candles.slice(-3);
  const touchedFastEma = recent.some((c) => c.l <= emaFastVal * 1.004);
  const inUptrend = (regime === "trending_up" || regime === "breakout") && slowRising;
  const rsiCurlingUp = rsiPrev < 45 && rsiNow > rsiPrev && rsiNow < 65;
  const pullback = inUptrend && touchedFastEma && rsiCurlingUp;

  // ── RSI extremes (for range mean-reversion gate) ──────────
  const rsiOverbought = rsiNow >= 70;
  const rsiOversold   = rsiNow <= 30;

  // ── Setup score (matches server formula exactly) ──────────
  const trendBoost =
    regime === "trending_up" || regime === "breakout" ? 0.25
    : regime === "trending_down" ? 0.1
    : 0;
  const volBoost   = volatility === "normal" ? 0.2 : volatility === "low" ? 0.05 : 0;
  const pullbackBoost = pullback ? 0.2 : 0;
  // Range reversion boost: only when RSI is at an extreme
  const rangeReversionBoost =
    regime === "range" && (rsiOverbought || rsiOversold) ? 0.15 : 0;

  const setupScore = Math.min(
    1,
    Math.max(
      0,
      confidence * 0.35 +
        todScore * 0.25 +
        trendBoost +
        volBoost +
        pullbackBoost +
        rangeReversionBoost,
    ),
  );

  // ── No-trade reasons (matches server noTradeReasons) ─────
  const noTradeReasons: string[] = [];
  if (setupScore < MIN_SETUP_SCORE_LIVE)
    noTradeReasons.push(`Setup score ${setupScore.toFixed(2)} below ${MIN_SETUP_SCORE_LIVE}`);
  if (volatility === "extreme")
    noTradeReasons.push("Volatility extreme");
  if (regime === "chop")
    noTradeReasons.push("Chop regime — no edge, sitting out");
  if (regime === "range" && !rsiOverbought && !rsiOversold)
    noTradeReasons.push(
      `Range regime — RSI ${rsiNow.toFixed(0)} not at extreme (need ≥70 or ≤30 for mean-reversion)`,
    );
  if (todScore < 0.4)
    noTradeReasons.push("Outside prime liquidity window");

  // ── Human summary ─────────────────────────────────────────
  const dirWord = pctChange >= 0 ? "up" : "down";
  const pullbackNote = pullback ? " · pullback detected (buy-the-dip setup)" : "";
  const rangeNote =
    regime === "range"
      ? rsiOverbought
        ? " · RSI overbought — fade opportunity"
        : rsiOversold
        ? " · RSI oversold — fade opportunity"
        : " · RSI mid-range — no fade edge"
      : "";
  const summary =
    `${symbol} is ${regime.replace(/_/g, " ")} — ${Math.abs(pctChange).toFixed(2)}% ${dirWord} over the window. ` +
    `Vol ${volatility} (${annualizedVolPct.toFixed(0)}% ann.), RSI ${rsiNow.toFixed(0)}. ` +
    `Setup score ${setupScore.toFixed(2)} (threshold ${MIN_SETUP_SCORE_LIVE})` +
    pullbackNote +
    rangeNote +
    ".";

  return {
    symbol,
    regime,
    confidence,
    volatility,
    spread,
    timeOfDayScore: todScore,
    setupScore,
    noTradeReasons,
    summary,
    rsiNow,
    rsiPrev,
    emaFast: emaFastVal,
    emaSlow: emaSlowVal,
    slowRising,
    pullback,
    annualizedVolPct,
    pctChange,
    rsiOverbought,
    rsiOversold,
  };
}
