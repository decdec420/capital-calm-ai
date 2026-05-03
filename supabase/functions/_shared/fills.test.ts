// Tests for fills.ts — slippage math + effective PnL.
import { assertEquals, assert, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { computeSlippagePct, effectivePnl } from "./fills.ts";

Deno.test("computeSlippagePct — BUY paying more is positive (bad)", () => {
  const slip = computeSlippagePct("BUY", 100, 100.5);
  assertEquals(slip, 0.005);
});

Deno.test("computeSlippagePct — BUY price improvement is negative (good)", () => {
  const slip = computeSlippagePct("BUY", 100, 99.5);
  assertEquals(slip, -0.005);
});

Deno.test("computeSlippagePct — SELL getting less is positive (bad)", () => {
  // Sold at 99.5 vs proposed 100 — 0.5% worse.
  const slip = computeSlippagePct("SELL", 100, 99.5);
  assert(slip !== null && Math.abs(slip - 0.005) < 1e-9);
});

Deno.test("computeSlippagePct — null on missing inputs", () => {
  assertEquals(computeSlippagePct("BUY", 0, 100), null);
  assertEquals(computeSlippagePct("BUY", null, 100), null);
  assertEquals(computeSlippagePct("BUY", 100, 0), null);
});

Deno.test("effectivePnl — subtracts both legs", () => {
  // Gross win of $5, paid $0.40 entry fees + $0.45 exit fees → $4.15 net.
  assertAlmostEquals(effectivePnl(5, 0.4, 0.45), 4.15, 1e-9);
});

Deno.test("effectivePnl — handles missing fee fields", () => {
  assertEquals(effectivePnl(5, undefined as unknown as number, undefined as unknown as number), 5);
});
