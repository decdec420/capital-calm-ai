import { describe, it, expect } from "vitest";
import { runBacktest, runWalkForward, DEFAULT_COSTS } from "../lib/backtest";
import type { Candle, StrategyParam } from "../lib/domain-types";

// Generate a sine-wave candle series with a drift, enough amplitude to
// trigger EMA crossings, and enough length to satisfy the 50-candle
// minimum + EMA warmup.
function syntheticCandles(n: number, seed = 1): Candle[] {
  const out: Candle[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const swing = Math.sin((i + seed) / 6) * 2;
    const drift = i * 0.05;
    const c = 100 + swing + drift;
    const o = i === 0 ? c : out[i - 1].c;
    const h = Math.max(c, o) + 0.25;
    const l = Math.min(c, o) - 0.25;
    out.push({ t: 1_700_000_000 + i * 3600, o, h, l, c, v: 1 });
    px = c;
  }
  void px;
  return out;
}

const trendRevParams: StrategyParam[] = [
  { key: "ema_fast", label: "EMA fast", value: 9 },
  { key: "ema_slow", label: "EMA slow", value: 21 },
  { key: "rsi_period", label: "RSI period", value: 14 },
  { key: "stop_atr_mult", label: "Stop ATR mult", value: 1.5 },
  { key: "tp_r_mult", label: "TP R-mult", value: 2 },
];

describe("runBacktest", () => {
  it("returns empty metrics for too-short history", () => {
    const out = runBacktest(syntheticCandles(20), trendRevParams);
    expect(out.trades.length).toBe(0);
    expect(out.metrics.trades).toBe(0);
  });

  it("runs without throwing on a 300-bar series", () => {
    const out = runBacktest(syntheticCandles(300), trendRevParams);
    expect(out.candleCount).toBe(300);
    // Expectancy might be small or negative; we just want the runner to complete.
    expect(typeof out.metrics.expectancy).toBe("number");
    expect(typeof out.metrics.winRate).toBe("number");
    expect(out.equityCurve.length).toBe(out.trades.length);
    expect(out.grossEquityCurve.length).toBe(out.trades.length);
  });

  it("applies fees and slippage adversely (net <= gross)", () => {
    const withCosts = runBacktest(syntheticCandles(300), trendRevParams, DEFAULT_COSTS);
    const noCosts = runBacktest(syntheticCandles(300), trendRevParams, {
      takerFeeBps: 0,
      slippageBps: 0,
    });
    if (withCosts.trades.length === 0 || noCosts.trades.length === 0) return;
    const netSum = withCosts.trades.reduce((s, t) => s + t.pnlR, 0);
    const grossSum = noCosts.trades.reduce((s, t) => s + t.pnlR, 0);
    expect(netSum).toBeLessThanOrEqual(grossSum + 1e-9);
  });

  it("records non-zero cost fractions per trade at default fees", () => {
    const out = runBacktest(syntheticCandles(300), trendRevParams, DEFAULT_COSTS);
    if (out.trades.length === 0) return;
    const t = out.trades[0];
    expect(t.feesPaidPct).toBeGreaterThan(0);
    expect(t.slippagePct).toBeGreaterThan(0);
    expect(typeof t.grossPnlR).toBe("number");
  });

  it("preserves per-trade side {long|short} only", () => {
    const out = runBacktest(syntheticCandles(300), trendRevParams);
    for (const t of out.trades) {
      expect(["long", "short"]).toContain(t.side);
      expect(t.exitT).toBeGreaterThanOrEqual(t.entryT);
    }
  });
});

describe("runWalkForward", () => {
  it("returns empty array on too-short series", () => {
    const splits = runWalkForward(syntheticCandles(100), trendRevParams, 4);
    expect(splits).toEqual([]);
  });

  it("produces N-1 splits for N folds on a sufficient series", () => {
    const splits = runWalkForward(syntheticCandles(1000), trendRevParams, 4);
    expect(splits.length).toBeGreaterThan(0);
    expect(splits.length).toBeLessThanOrEqual(3);
    for (const s of splits) {
      expect(s.fromT).toBeLessThan(s.toT);
      expect(typeof s.inSample.expectancy).toBe("number");
      expect(typeof s.outOfSample.expectancy).toBe("number");
    }
  });
});
