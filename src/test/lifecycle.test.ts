import { describe, it, expect } from "vitest";
import {
  transitionSignal,
  transitionTrade,
  transitionStrategy,
  appendTransition,
  evaluateTradeInCandle,
} from "../../supabase/functions/_shared/lifecycle";

describe("signal FSM", () => {
  it("allows proposed → approved → executed", () => {
    const a = transitionSignal("proposed", "approved");
    expect(a.ok).toBe(true);
    const b = transitionSignal("approved", "executed");
    expect(b.ok).toBe(true);
  });

  it("rejects illegal jumps (proposed → executed skipping approval)", () => {
    const r = transitionSignal("proposed", "executed");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Illegal/);
  });

  it("rejects transitions from terminal phases", () => {
    const r = transitionSignal("executed", "rejected");
    expect(r.ok).toBe(false);
  });

  it("attaches transition metadata on success", () => {
    const r = transitionSignal("proposed", "approved", { actor: "operator", reason: "thumbs up" });
    expect(r.ok).toBe(true);
    expect(r.transition?.phase).toBe("approved");
    expect(r.transition?.by).toBe("operator");
    expect(r.transition?.reason).toBe("thumbs up");
  });
});

describe("trade FSM", () => {
  it("allows entered → monitored → tp1_hit → exited → archived", () => {
    expect(transitionTrade("entered", "monitored").ok).toBe(true);
    expect(transitionTrade("monitored", "tp1_hit").ok).toBe(true);
    expect(transitionTrade("tp1_hit", "exited").ok).toBe(true);
    expect(transitionTrade("exited", "archived").ok).toBe(true);
  });

  it("allows entered → exited directly (stopped out before TP1)", () => {
    expect(transitionTrade("entered", "exited").ok).toBe(true);
  });

  it("disallows resurrection of archived trades", () => {
    expect(transitionTrade("archived", "monitored").ok).toBe(false);
    expect(transitionTrade("archived", "exited").ok).toBe(false);
  });
});

describe("strategy FSM", () => {
  it("allows the full lifecycle seeded → candidate → approved → live → retired", () => {
    expect(transitionStrategy("seeded", "candidate").ok).toBe(true);
    expect(transitionStrategy("candidate", "approved").ok).toBe(true);
    expect(transitionStrategy("approved", "live").ok).toBe(true);
    expect(transitionStrategy("live", "retired").ok).toBe(true);
  });

  it("can demote live back to approved (kill-switch style)", () => {
    expect(transitionStrategy("live", "approved").ok).toBe(true);
  });
});

describe("appendTransition", () => {
  it("handles null and undefined prior arrays", () => {
    const t = { phase: "approved", at: "now" };
    expect(appendTransition(null, t)).toEqual([t]);
    expect(appendTransition(undefined, t)).toEqual([t]);
  });

  it("appends to an existing array", () => {
    const prev = [{ phase: "proposed", at: "t0" }];
    const t = { phase: "approved", at: "t1" };
    expect(appendTransition(prev, t)).toEqual([...prev, t]);
  });
});

describe("evaluateTradeInCandle", () => {
  const baseInput = {
    side: "long" as const,
    entryPrice: 100,
    stopPrice: 95,
    tp1Price: 105,
    tp2Price: 110,
    originalSize: 1,
    remainingSize: 1,
    tp1Filled: false,
  };

  it("holds when price stays inside the band", () => {
    const out = evaluateTradeInCandle({
      ...baseInput,
      candle: { high: 102, low: 98, close: 101 },
    });
    expect(out.type).toBe("hold");
  });

  it("fills TP1 on a reach-up candle and proposes BE stop", () => {
    const out = evaluateTradeInCandle({
      ...baseInput,
      candle: { high: 106, low: 99, close: 105 },
    });
    expect(out.type).toBe("tp1_fill");
    if (out.type === "tp1_fill") {
      expect(out.fillPrice).toBe(105);
      expect(out.closedQty).toBe(0.5);
      expect(out.newStop).toBe(100); // entry = BE
    }
  });

  it("fires stop before TP1 on same-candle sweep (pessimistic ordering)", () => {
    const out = evaluateTradeInCandle({
      ...baseInput,
      candle: { high: 106, low: 94, close: 105 },
    });
    expect(out.type).toBe("stop_hit");
  });

  it("fills TP2 after TP1 already banked", () => {
    const out = evaluateTradeInCandle({
      ...baseInput,
      tp1Filled: true,
      stopPrice: 100, // BE stop after TP1
      remainingSize: 0.5,
      candle: { high: 111, low: 101, close: 110 },
    });
    expect(out.type).toBe("tp2_hit");
    if (out.type === "tp2_hit") {
      expect(out.fillPrice).toBe(110);
      expect(out.closedQty).toBe(0.5);
    }
  });

  it("mirrors for short side — TP1 is a reach-down", () => {
    const out = evaluateTradeInCandle({
      ...baseInput,
      side: "short",
      entryPrice: 100,
      stopPrice: 105,
      tp1Price: 95,
      tp2Price: 90,
      candle: { high: 101, low: 94, close: 95 },
    });
    expect(out.type).toBe("tp1_fill");
    if (out.type === "tp1_fill") {
      expect(out.fillPrice).toBe(95);
      expect(out.newStop).toBe(100);
    }
  });

  it("short-side stop fires on an upward sweep", () => {
    const out = evaluateTradeInCandle({
      ...baseInput,
      side: "short",
      entryPrice: 100,
      stopPrice: 105,
      tp1Price: 95,
      tp2Price: 90,
      candle: { high: 106, low: 95, close: 105 },
    });
    expect(out.type).toBe("stop_hit");
  });
});
