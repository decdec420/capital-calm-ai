import { describe, it, expect } from "vitest";
import {
  transitionSignal,
  transitionTrade,
  transitionStrategy,
  appendTransition,
  computeNewTrailingStop,
  evaluateTradeInCandle,
  regimeFlippedAgainstTrade,
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

describe("regimeFlippedAgainstTrade", () => {
  it("long in trending_down is flipped", () => {
    expect(regimeFlippedAgainstTrade("long", "trending_down")).toBe(true);
  });
  it("long in chop is flipped", () => {
    expect(regimeFlippedAgainstTrade("long", "chop")).toBe(true);
  });
  it("long in trending_up is aligned", () => {
    expect(regimeFlippedAgainstTrade("long", "trending_up")).toBe(false);
  });
  it("long in breakout is aligned", () => {
    expect(regimeFlippedAgainstTrade("long", "breakout")).toBe(false);
  });
  it("short in trending_up is flipped", () => {
    expect(regimeFlippedAgainstTrade("short", "trending_up")).toBe(true);
  });
  it("short in breakout is flipped", () => {
    expect(regimeFlippedAgainstTrade("short", "breakout")).toBe(true);
  });
  it("short in trending_down is aligned", () => {
    expect(regimeFlippedAgainstTrade("short", "trending_down")).toBe(false);
  });
  it("null regime returns false", () => {
    expect(regimeFlippedAgainstTrade("long", null)).toBe(false);
    expect(regimeFlippedAgainstTrade("short", null)).toBe(false);
  });
});

describe("computeNewTrailingStop", () => {
  // entry=$150, risk=$1.50 (TP1=$151.50), activation=1.5R=$152.25

  it("returns null when candle.high is below activation threshold", () => {
    expect(computeNewTrailingStop("long", 150, 1.5, 150, 152.0, 149.5)).toBeNull();
  });

  it("activates and returns new stop above current", () => {
    // high=$152.50 → trail = $152.50 - $0.75 = $151.75
    expect(computeNewTrailingStop("long", 150, 1.5, 150, 152.5, 151.0)).toBeCloseTo(151.75, 3);
  });

  it("returns null when trail candidate would not advance (never moves down)", () => {
    // currentStop already $151.75; high=$152.40, candidate=$151.65 < $151.75 → no change
    expect(computeNewTrailingStop("long", 150, 1.5, 151.75, 152.4, 151.5)).toBeNull();
  });

  it("advances when price moves to a new high", () => {
    // currentStop $151.75, high=$153 → $153 - $0.75 = $152.25
    expect(computeNewTrailingStop("long", 150, 1.5, 151.75, 153.0, 152.0)).toBeCloseTo(152.25, 3);
  });

  it("short side activates below entry", () => {
    // entry=$100, risk=$2, activation=$97, low=$96.5 → candidate=$97.5
    expect(computeNewTrailingStop("short", 100, 2, 100, 100.5, 96.5)).toBeCloseTo(97.5, 3);
  });

  it("returns null for zero riskPerUnit", () => {
    expect(computeNewTrailingStop("long", 100, 0, 100, 110, 99)).toBeNull();
  });
});

describe("evaluateTradeInCandle — regime_exit and trailing stop", () => {
  const runnerBase = {
    side: "long" as const,
    entryPrice: 150,
    stopPrice: 150,  // breakeven post-TP1
    tp1Price: 151.5,
    tp2Price: 154,
    originalSize: 1,
    remainingSize: 0.5,
    tp1Filled: true,
  };

  it("regime_exit fires in runner phase when regime flips against long", () => {
    const r = evaluateTradeInCandle({
      ...runnerBase,
      candle: { high: 151, low: 150.2, close: 150.8 },
      currentRegime: "trending_down",
    });
    expect(r.type).toBe("regime_exit");
    if (r.type === "regime_exit") {
      expect(r.fillPrice).toBe(150.8); // candle close
      expect(r.closedQty).toBe(0.5);
    }
  });

  it("regime_exit does NOT fire before TP1 (runner phase not started)", () => {
    const r = evaluateTradeInCandle({
      ...runnerBase,
      tp1Filled: false,
      stopPrice: 148.5,
      remainingSize: 1,
      candle: { high: 151, low: 149, close: 150.5 },
      currentRegime: "trending_down",
    });
    expect(r.type).toBe("hold");
  });

  it("regime_exit does not fire when regime is aligned", () => {
    const r = evaluateTradeInCandle({
      ...runnerBase,
      candle: { high: 151, low: 150.2, close: 150.8 },
      currentRegime: "trending_up",
    });
    expect(r.type).toBe("hold");
  });

  it("stop takes priority over regime_exit when both triggered same candle", () => {
    const r = evaluateTradeInCandle({
      ...runnerBase,
      stopPrice: 150,
      candle: { high: 151, low: 149.9, close: 150.5 },
      currentRegime: "trending_down",
    });
    expect(r.type).toBe("stop_hit");
    if (r.type === "stop_hit") expect(r.fillPrice).toBe(150);
  });

  it("trailing stop activates and returns newTrailingStop in hold", () => {
    // high=$152.50 → trail=$151.75, low=$151.90 not hit → hold
    const r = evaluateTradeInCandle({
      ...runnerBase,
      candle: { high: 152.5, low: 151.9, close: 152.2 },
      currentRegime: "trending_up",
    });
    expect(r.type).toBe("hold");
    if (r.type === "hold") expect(r.newTrailingStop).toBeCloseTo(151.75, 3);
  });

  it("trailing stop hit in same candle (wick-and-reverse) → stop_hit at trail price", () => {
    // high=$153 → trail=$152.25, but candle.low=$151 < $152.25 → stop_hit at $152.25
    const r = evaluateTradeInCandle({
      ...runnerBase,
      candle: { high: 153, low: 151, close: 151.5 },
      currentRegime: "trending_up",
    });
    expect(r.type).toBe("stop_hit");
    if (r.type === "stop_hit") expect(r.fillPrice).toBeCloseTo(152.25, 3);
  });

  it("no trail action when candle.high is below trail activation", () => {
    // activation at $152.25, candle.high=$152.0 → no trail
    const r = evaluateTradeInCandle({
      ...runnerBase,
      candle: { high: 152.0, low: 151.5, close: 151.8 },
      currentRegime: "trending_up",
    });
    expect(r.type).toBe("hold");
    if (r.type === "hold") expect(r.newTrailingStop).toBeUndefined();
  });
});
