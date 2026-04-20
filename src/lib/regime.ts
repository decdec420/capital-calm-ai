import type { Candle, MarketRegime, Regime, SpreadQuality, VolatilityState } from "./domain-types";

// Compute a market regime from raw candles. Pure function — no I/O.
export function computeRegime(symbol: string, candles: Candle[]): MarketRegime {
  if (candles.length < 20) {
    return {
      symbol,
      regime: "range",
      confidence: 0,
      volatility: "normal",
      spread: "tight",
      timeOfDayScore: 0.5,
      setupScore: 0,
      noTradeReasons: ["Not enough data — waiting for fresh candles."],
      summary: "Bot is waking up. Calibrating on the latest BTC tape — no trades until it has a real read.",
    };
  }

  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1];
  const first = closes[0];
  const pctChange = ((last - first) / first) * 100;

  // Simple volatility = stdev of returns
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const stdev = Math.sqrt(variance);
  const annualizedVolPct = stdev * Math.sqrt(24 * 365) * 100;

  let volatility: VolatilityState = "normal";
  if (annualizedVolPct < 30) volatility = "low";
  else if (annualizedVolPct > 80) volatility = "elevated";
  if (annualizedVolPct > 140) volatility = "extreme";

  // Range vs trend: compare price drift to the candle range.
  const high = Math.max(...candles.map((c) => c.h));
  const low = Math.min(...candles.map((c) => c.l));
  const rangePct = ((high - low) / low) * 100;
  const driftRatio = Math.abs(pctChange) / Math.max(rangePct, 0.01);

  let regime: Regime = "range";
  if (driftRatio > 0.55) regime = pctChange > 0 ? "trending_up" : "trending_down";
  else if (rangePct < 0.8) regime = "chop";
  // breakout: last candle close above prior 20-bar high
  const prior20High = Math.max(...candles.slice(-21, -1).map((c) => c.h));
  if (last > prior20High * 1.001) regime = "breakout";

  const confidence = Math.min(1, Math.max(0.25, driftRatio * 1.2));

  // Spread is unknown from candles alone; we mark tight unless vol is extreme.
  const spread: SpreadQuality = volatility === "extreme" ? "wide" : volatility === "elevated" ? "normal" : "tight";

  // Time-of-day score (UTC) — favor 13:00–21:00 (NY/London overlap).
  const hour = new Date().getUTCHours();
  const todScore = hour >= 13 && hour < 21 ? 0.85 : hour >= 7 && hour < 23 ? 0.55 : 0.3;

  // Composite setup score
  const trendBoost = regime === "trending_up" || regime === "breakout" ? 0.25 : regime === "trending_down" ? 0.1 : 0;
  const volBoost = volatility === "normal" ? 0.2 : volatility === "low" ? 0.05 : 0;
  const setupScore = Math.min(1, Math.max(0, confidence * 0.4 + todScore * 0.3 + trendBoost + volBoost));

  const noTradeReasons: string[] = [];
  if (setupScore < 0.65) noTradeReasons.push(`Setup score ${setupScore.toFixed(2)} below 0.65 threshold`);
  if (volatility === "extreme") noTradeReasons.push("Volatility is extreme — sit out or shrink size");
  if (regime === "chop") noTradeReasons.push("Chop regime — no clean edge available");
  if (todScore < 0.4) noTradeReasons.push("Outside prime liquidity window");

  const dirWord = pctChange >= 0 ? "up" : "down";
  const summary =
    `BTC is ${regime.replace("_", " ")} on the last ${candles.length}h, ${Math.abs(pctChange).toFixed(2)}% ${dirWord}. ` +
    `Volatility ${volatility}, range ${rangePct.toFixed(2)}%. Setup score ${setupScore.toFixed(2)} ` +
    `(${setupScore >= 0.65 ? "above" : "below"} entry threshold).`;

  return { symbol, regime, confidence, volatility, spread, timeOfDayScore: todScore, setupScore, noTradeReasons, summary };
}
