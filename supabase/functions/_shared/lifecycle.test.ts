import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  appendTransition,
  computeNewTrailingStop,
  evaluateTradeInCandle,
  regimeFlippedAgainstTrade,
  transitionSignal,
  transitionStrategy,
  transitionTrade,
} from "./lifecycle.ts";

// ─── Signal FSM ────────────────────────────────────────────────
Deno.test("signal FSM — proposed → approved is legal", () => {
  const r = transitionSignal("proposed", "approved", { actor: "user" });
  assertEquals(r.ok, true);
  assertEquals(r.transition?.phase, "approved");
});

Deno.test("signal FSM — rejected is terminal", () => {
  const r = transitionSignal("rejected", "executed");
  assertEquals(r.ok, false);
});

Deno.test("signal FSM — proposed → executed is illegal (must go via approved)", () => {
  const r = transitionSignal("proposed", "executed");
  assertEquals(r.ok, false);
});

// ─── Trade FSM ─────────────────────────────────────────────────
Deno.test("trade FSM — entered → tp1_hit → exited → archived", () => {
  const a = transitionTrade("entered", "tp1_hit");
  const b = transitionTrade("tp1_hit", "exited");
  const c = transitionTrade("exited", "archived");
  assertEquals(a.ok, true);
  assertEquals(b.ok, true);
  assertEquals(c.ok, true);
});

Deno.test("trade FSM — archived is terminal", () => {
  const r = transitionTrade("archived", "exited");
  assertEquals(r.ok, false);
});

// ─── Strategy FSM ─────────────────────────────────────────────
Deno.test("strategy FSM — seeded → candidate → approved → live", () => {
  const a = transitionStrategy("seeded", "candidate");
  const b = transitionStrategy("candidate", "approved");
  const c = transitionStrategy("approved", "live");
  assertEquals(a.ok, true);
  assertEquals(b.ok, true);
  assertEquals(c.ok, true);
});

Deno.test("strategy FSM — live can demote to approved or retired", () => {
  assertEquals(transitionStrategy("live", "approved").ok, true);
  assertEquals(transitionStrategy("live", "retired").ok, true);
  assertEquals(transitionStrategy("live", "seeded").ok, false);
});

// ─── appendTransition ─────────────────────────────────────────
Deno.test("appendTransition — null prev returns [t]", () => {
  const t = {
    phase: "proposed",
    at: "2026-04-20T00:00:00Z",
  };
  assertEquals(appendTransition(null, t), [t]);
});

Deno.test("appendTransition — existing array appends", () => {
  const existing = [
    { phase: "proposed", at: "2026-04-20T00:00:00Z" },
  ];
  const next = { phase: "approved", at: "2026-04-20T00:01:00Z" };
  assertEquals(appendTransition(existing, next), [...existing, next]);
});

// ─── evaluateTradeInCandle ────────────────────────────────────
Deno.test("evaluateTradeInCandle — stop hit closes full remaining size", () => {
  const r = evaluateTradeInCandle({
    side: "long",
    entryPrice: 100,
    stopPrice: 98,
    tp1Price: 102,
    tp2Price: 104,
    originalSize: 1,
    remainingSize: 1,
    tp1Filled: false,
    candle: { high: 101, low: 97, close: 99 },
  });
  assertEquals(r.type, "stop_hit");
  if (r.type === "stop_hit") {
    assertEquals(r.fillPrice, 98);
    assertEquals(r.closedQty, 1);
  }
});

Deno.test("evaluateTradeInCandle — TP1 fill closes half, moves stop to BE", () => {
  const r = evaluateTradeInCandle({
    side: "long",
    entryPrice: 100,
    stopPrice: 98,
    tp1Price: 102,
    tp2Price: 104,
    originalSize: 1,
    remainingSize: 1,
    tp1Filled: false,
    candle: { high: 102.5, low: 99, close: 102 },
  });
  assertEquals(r.type, "tp1_fill");
  if (r.type === "tp1_fill") {
    assertEquals(r.fillPrice, 102);
    assertEquals(r.closedQty, 0.5);
    assertEquals(r.newStop, 100); // entry
  }
});

Deno.test("evaluateTradeInCandle — TP2 hit closes runner", () => {
  const r = evaluateTradeInCandle({
    side: "long",
    entryPrice: 100,
    stopPrice: 100, // moved to BE post-TP1
    tp1Price: 102,
    tp2Price: 104,
    originalSize: 1,
    remainingSize: 0.5,
    tp1Filled: true,
    candle: { high: 104.5, low: 102, close: 104 },
  });
  assertEquals(r.type, "tp2_hit");
  if (r.type === "tp2_hit") {
    assertEquals(r.fillPrice, 104);
    assertEquals(r.closedQty, 0.5);
  }
});

Deno.test("evaluateTradeInCandle — stop-first precedence on same-candle stop+TP1", () => {
  const r = evaluateTradeInCandle({
    side: "long",
    entryPrice: 100,
    stopPrice: 98,
    tp1Price: 102,
    tp2Price: 104,
    originalSize: 1,
    remainingSize: 1,
    tp1Filled: false,
    // both stop AND tp1 touched in same candle (adverse spike)
    candle: { high: 102, low: 97.5, close: 100 },
  });
  assertEquals(r.type, "stop_hit");
});

Deno.test("evaluateTradeInCandle — short: stop above, tp below", () => {
  const r = evaluateTradeInCandle({
    side: "short",
    entryPrice: 100,
    stopPrice: 102,
    tp1Price: 98,
    tp2Price: 96,
    originalSize: 1,
    remainingSize: 1,
    tp1Filled: false,
    candle: { high: 100.5, low: 97, close: 98 },
  });
  assertEquals(r.type, "tp1_fill");
  if (r.type === "tp1_fill") {
    assertEquals(r.fillPrice, 98);
    assertEquals(r.newStop, 100);
  }
});

Deno.test("evaluateTradeInCandle — no trigger returns hold", () => {
  const r = evaluateTradeInCandle({
    side: "long",
    entryPrice: 100,
    stopPrice: 98,
    tp1Price: 102,
    tp2Price: 104,
    originalSize: 1,
    remainingSize: 1,
    tp1Filled: false,
    candle: { high: 100.5, low: 99.5, close: 100 },
  });
  assertEquals(r.type, "hold");
});

Deno.test("evaluateTradeInCandle — tight TP1 fires when bar high tagged it (spot below)", () => {
  // Simulates the post-fix MTM realism: spot is currently 100.40 but the
  // most-recent 1m bar wicked up to 100.55 — TP1 at 100.50 must fire.
  const r = evaluateTradeInCandle({
    side: "long",
    entryPrice: 100,
    stopPrice: 99,           // 1% stop
    tp1Price: 100.5,         // 0.5R TP1 (small-account tier)
    tp2Price: 102,
    originalSize: 1,
    remainingSize: 1,
    tp1Filled: false,
    candle: { high: 100.55, low: 99.95, close: 100.4 },
  });
  assertEquals(r.type, "tp1_fill");
  if (r.type === "tp1_fill") {
    assertEquals(r.fillPrice, 100.5);
    assertEquals(r.newStop, 100); // breakeven = entry
    assertEquals(r.closedQty, 0.5);
  }
});

Deno.test("evaluateTradeInCandle — flat synthetic bar (spot only) does NOT fire TP1 below it", () => {
  // Pre-fix behaviour: when 1m fetch fails we fall back to high=low=close=spot.
  // Spot 100.40 with TP1 at 100.50 must remain hold (no synthetic spike).
  const r = evaluateTradeInCandle({
    side: "long",
    entryPrice: 100,
    stopPrice: 99,
    tp1Price: 100.5,
    tp2Price: 102,
    originalSize: 1,
    remainingSize: 1,
    tp1Filled: false,
    candle: { high: 100.4, low: 100.4, close: 100.4 },
  });
  assertEquals(r.type, "hold");
});

// ─── regimeFlippedAgainstTrade ────────────────────────────────
Deno.test("regimeFlippedAgainstTrade — long in trending_down is flipped", () => {
  assertEquals(regimeFlippedAgainstTrade("long", "trending_down"), true);
});

Deno.test("regimeFlippedAgainstTrade — long in chop is flipped", () => {
  assertEquals(regimeFlippedAgainstTrade("long", "chop"), true);
});

Deno.test("regimeFlippedAgainstTrade — long in trending_up is aligned", () => {
  assertEquals(regimeFlippedAgainstTrade("long", "trending_up"), false);
});

Deno.test("regimeFlippedAgainstTrade — long in breakout is aligned", () => {
  assertEquals(regimeFlippedAgainstTrade("long", "breakout"), false);
});

Deno.test("regimeFlippedAgainstTrade — short in trending_up is flipped", () => {
  assertEquals(regimeFlippedAgainstTrade("short", "trending_up"), true);
});

Deno.test("regimeFlippedAgainstTrade — short in breakout is flipped", () => {
  assertEquals(regimeFlippedAgainstTrade("short", "breakout"), true);
});

Deno.test("regimeFlippedAgainstTrade — short in trending_down is aligned", () => {
  assertEquals(regimeFlippedAgainstTrade("short", "trending_down"), false);
});

Deno.test("regimeFlippedAgainstTrade — null regime returns false", () => {
  assertEquals(regimeFlippedAgainstTrade("long", null), false);
  assertEquals(regimeFlippedAgainstTrade("short", null), false);
});

// ─── computeNewTrailingStop ───────────────────────────────────
// entry=$150, risk=$1.50 (TP1=$151.50), activation=1.5R=$152.25, trail=0.5R

Deno.test("computeNewTrailingStop — not yet activated returns null", () => {
  // candle.high only reached $152.00, below the $152.25 activation
  const r = computeNewTrailingStop("long", 150, 1.5, 150, 152.0, 149.5);
  assertEquals(r, null);
});

Deno.test("computeNewTrailingStop — activates and returns new stop", () => {
  // candle.high = $152.50 → activation triggered, trail = $152.50 - $0.75 = $151.75
  const r = computeNewTrailingStop("long", 150, 1.5, 150, 152.5, 151.0);
  assertAlmostEquals(r!, 151.75, 0.001);
});

Deno.test("computeNewTrailingStop — trail never moves down", () => {
  // currentStop already at $151.75 from a previous tick; candle.high only $152.40
  // potential new stop = $152.40 - $0.75 = $151.65, but that's below $151.75 → no change
  const r = computeNewTrailingStop("long", 150, 1.5, 151.75, 152.4, 151.5);
  assertEquals(r, null); // no change
});

Deno.test("computeNewTrailingStop — advances when price moves higher", () => {
  // currentStop $151.75, candle.high $153 → $153 - $0.75 = $152.25
  const r = computeNewTrailingStop("long", 150, 1.5, 151.75, 153.0, 152.0);
  assertAlmostEquals(r!, 152.25, 0.001);
});

Deno.test("computeNewTrailingStop — short side: activates below entry", () => {
  // entry=$100, risk=$2, activation=1.5R=$97, trail=0.5R above low
  // candle.low=$96.5 → activated, candidate=$96.5+$1=$97.5, currentStop=$100 → min($100,$97.5)=$97.5
  const r = computeNewTrailingStop("short", 100, 2, 100, 100.5, 96.5);
  assertAlmostEquals(r!, 97.5, 0.001);
});

Deno.test("computeNewTrailingStop — zero riskPerUnit returns null", () => {
  assertEquals(computeNewTrailingStop("long", 100, 0, 100, 110, 99), null);
});

// ─── evaluateTradeInCandle — regime_exit ─────────────────────

Deno.test("evaluateTradeInCandle — regime_exit fires in runner phase when regime flips (long)", () => {
  const r = evaluateTradeInCandle({
    side: "long",
    entryPrice: 100,
    stopPrice: 100, // breakeven post-TP1
    tp1Price: 102,
    tp2Price: 104,
    originalSize: 1,
    remainingSize: 0.5,
    tp1Filled: true,
    candle: { high: 101, low: 100.5, close: 100.8 },
    currentRegime: "trending_down",
  });
  assertEquals(r.type, "regime_exit");
  if (r.type === "regime_exit") {
    assertEquals(r.fillPrice, 100.8); // candle close
    assertEquals(r.closedQty, 0.5);
  }
});

Deno.test("evaluateTradeInCandle — regime_exit does NOT fire before TP1", () => {
  // tp1Filled=false → runner phase not started, regime flip is ignored
  const r = evaluateTradeInCandle({
    side: "long",
    entryPrice: 100,
    stopPrice: 98,
    tp1Price: 102,
    tp2Price: 104,
    originalSize: 1,
    remainingSize: 1,
    tp1Filled: false,
    candle: { high: 101, low: 99, close: 100.5 },
    currentRegime: "trending_down",
  });
  assertEquals(r.type, "hold");
});

Deno.test("evaluateTradeInCandle — regime_exit aligned regime keeps hold", () => {
  const r = evaluateTradeInCandle({
    side: "long",
    entryPrice: 100,
    stopPrice: 100,
    tp1Price: 102,
    tp2Price: 104,
    originalSize: 1,
    remainingSize: 0.5,
    tp1Filled: true,
    candle: { high: 101, low: 100.2, close: 100.8 },
    currentRegime: "trending_up",
  });
  assertEquals(r.type, "hold");
});

Deno.test("evaluateTradeInCandle — stop still takes priority over regime_exit same candle", () => {
  // stop at 100 (BE), candle.low = 99.9 touches stop AND regime is flipped
  const r = evaluateTradeInCandle({
    side: "long",
    entryPrice: 100,
    stopPrice: 100,
    tp1Price: 102,
    tp2Price: 104,
    originalSize: 1,
    remainingSize: 0.5,
    tp1Filled: true,
    candle: { high: 101, low: 99.9, close: 100.5 },
    currentRegime: "trending_down",
  });
  assertEquals(r.type, "stop_hit");
  if (r.type === "stop_hit") assertEquals(r.fillPrice, 100);
});

// ─── evaluateTradeInCandle — trailing stop ────────────────────

Deno.test("evaluateTradeInCandle — trailing stop activates and signals new stop (hold)", () => {
  // entry=$150, tp1=$151.50, risk=$1.50, stop=BE=$150
  // candle.high=$152.50 → trail=$152.50-$0.75=$151.75, above stop $150
  // candle.low=$151.90 → not hit by trail
  const r = evaluateTradeInCandle({
    side: "long",
    entryPrice: 150,
    stopPrice: 150, // breakeven
    tp1Price: 151.5,
    tp2Price: 153,
    originalSize: 1,
    remainingSize: 0.5,
    tp1Filled: true,
    candle: { high: 152.5, low: 151.9, close: 152.2 },
    currentRegime: "trending_up",
  });
  assertEquals(r.type, "hold");
  if (r.type === "hold") assertAlmostEquals(r.newTrailingStop!, 151.75, 0.001);
});

Deno.test("evaluateTradeInCandle — trailing stop that is immediately hit → stop_hit", () => {
  // candle wicks to $153 then drops to $151 — trail = $152.25, candle.low $151 < $152.25
  const r = evaluateTradeInCandle({
    side: "long",
    entryPrice: 150,
    stopPrice: 150,
    tp1Price: 151.5,
    tp2Price: 154,
    originalSize: 1,
    remainingSize: 0.5,
    tp1Filled: true,
    candle: { high: 153, low: 151, close: 151.5 },
    currentRegime: "trending_up",
  });
  assertEquals(r.type, "stop_hit");
  if (r.type === "stop_hit") assertAlmostEquals(r.fillPrice, 152.25, 0.001);
});

Deno.test("evaluateTradeInCandle — trailing not yet activated, normal hold", () => {
  // candle.high only $152.0, activation at $152.25 → trail not yet active
  const r = evaluateTradeInCandle({
    side: "long",
    entryPrice: 150,
    stopPrice: 150,
    tp1Price: 151.5,
    tp2Price: 154,
    originalSize: 1,
    remainingSize: 0.5,
    tp1Filled: true,
    candle: { high: 152.0, low: 151.5, close: 151.8 },
    currentRegime: "trending_up",
  });
  assertEquals(r.type, "hold");
  if (r.type === "hold") assertEquals(r.newTrailingStop, undefined);
});
