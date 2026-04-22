import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeRegime, ema, rsi } from "./regime.ts";
import type { Candle } from "./market.ts";

function mkCandles(series: number[]): Candle[] {
  return series.map((c, i) => ({
    t: 1_700_000_000 + i * 3600,
    o: c,
    h: c * 1.002,
    l: c * 0.998,
    c,
    v: 1_000,
  }));
}

Deno.test("ema — converges on flat input", () => {
  const out = ema([10, 10, 10, 10, 10], 3);
  assertEquals(out[out.length - 1], 10);
});

Deno.test("rsi — perfectly rising returns 100", () => {
  const vals = Array.from({ length: 30 }, (_, i) => 100 + i);
  assertEquals(rsi(vals, 14), 100);
});

Deno.test("rsi — not enough data returns 50", () => {
  assertEquals(rsi([1, 2, 3], 14), 50);
});

Deno.test("computeRegime — too few candles returns no_trade fallback", () => {
  const r = computeRegime(mkCandles([1, 2, 3, 4, 5]));
  assertEquals(r.regime, "no_trade");
  assertEquals(r.noTradeReasons.length > 0, true);
});

Deno.test("computeRegime — steady uptrend → trending_up / breakout", () => {
  const series = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
  const r = computeRegime(mkCandles(series));
  // steady uptrend may register as either depending on prior20High comparison
  const allowed = ["trending_up", "breakout"];
  assertEquals(allowed.includes(r.regime), true);
});

Deno.test("computeRegime — flat market → chop or range", () => {
  const series = Array.from({ length: 30 }, () => 100);
  const r = computeRegime(mkCandles(series));
  const allowed = ["chop", "range"];
  assertEquals(allowed.includes(r.regime), true);
  assertEquals(r.noTradeReasons.some((x) => x.includes("no edge")), true);
});

Deno.test("computeRegime — todScore varies by UTC hour", () => {
  const series = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
  const usHours = computeRegime(mkCandles(series), {
    nowIso: "2026-04-20T15:00:00Z",
  });
  const offHours = computeRegime(mkCandles(series), {
    nowIso: "2026-04-20T03:00:00Z",
  });
  assertEquals(usHours.todScore, 0.85);
  assertEquals(offHours.todScore, 0.3);
});
