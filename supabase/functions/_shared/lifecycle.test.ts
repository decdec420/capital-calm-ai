import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  appendTransition,
  evaluateTradeInCandle,
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
