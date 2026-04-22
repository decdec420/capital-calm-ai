import { describe, it, expect } from "vitest";
import { computeRegime, TRADEABLE_REGIMES } from "../../supabase/functions/_shared/regime";

function flatCandles(n: number, price = 100) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      t: 1_700_000_000 + i * 3600,
      l: price * 0.999,
      h: price * 1.001,
      o: price,
      c: price + (i % 2 === 0 ? 0.01 : -0.01),
      v: 100,
    });
  }
  return out;
}

function uptrendCandles(n: number, start = 100, step = 0.25) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = start + step * i;
    out.push({
      t: 1_700_000_000 + i * 3600,
      l: c - 0.05,
      h: c + 0.35,
      o: c - 0.1,
      c,
      v: 100,
    });
  }
  return out;
}

describe("computeRegime", () => {
  it("returns no_trade with reasons on too-short history", () => {
    const r = computeRegime(flatCandles(10));
    expect(r.regime).toBe("no_trade");
    expect(r.noTradeReasons.length).toBeGreaterThan(0);
  });

  it("classifies a strong uptrend as trending_up or breakout", () => {
    const r = computeRegime(uptrendCandles(50));
    // With 50 hourly candles stepping 0.25 each: ~12% drift — clearly trending.
    expect(["trending_up", "breakout"]).toContain(r.regime);
    expect(TRADEABLE_REGIMES.has(r.regime)).toBe(true);
  });

  it("classifies a flat tape as range or chop", () => {
    const r = computeRegime(flatCandles(50, 100));
    expect(["range", "chop"]).toContain(r.regime);
    expect(r.noTradeReasons.length).toBeGreaterThan(0);
  });

  it("reports volatility bucket based on realized returns", () => {
    const r = computeRegime(flatCandles(50));
    expect(["low", "normal", "elevated", "extreme"]).toContain(r.volatility);
  });

  it("uses nowIso for time-of-day score in the NY window", () => {
    const r = computeRegime(uptrendCandles(50), { nowIso: "2026-04-21T15:00:00Z" });
    expect(r.todScore).toBeCloseTo(0.85, 2);
  });

  it("downgrades todScore outside the prime window", () => {
    const r = computeRegime(uptrendCandles(50), { nowIso: "2026-04-21T03:00:00Z" });
    expect(r.todScore).toBeLessThan(0.5);
  });
});
