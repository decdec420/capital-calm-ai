import { describe, it, expect } from "vitest";
import {
  evaluateTradeInCandle,
  type InCandleInputs,
} from "../../supabase/functions/_shared/lifecycle";

// ============================================================
// Dedicated mtm-engine coverage (P4-C)
// ------------------------------------------------------------
// `evaluateTradeInCandle()` is the pure-function core of every
// mark-to-market sweep. The basic happy paths are covered in
// lifecycle.test.ts; this file pins down the gnarly edges:
//   - exact-equal boundary prices (==stop, ==tp1, ==tp2)
//   - stop-first ordering on simultaneous hits
//   - degenerate inputs (zero size, missing tp prices)
//   - sequential-candle equity rolls
//   - both directions for every action type
// ============================================================

const longBase: InCandleInputs = {
  side: "long",
  entryPrice: 100,
  stopPrice: 95,
  tp1Price: 105,
  tp2Price: 110,
  originalSize: 1,
  remainingSize: 1,
  tp1Filled: false,
  candle: { high: 100, low: 100, close: 100 },
};

const shortBase: InCandleInputs = {
  ...longBase,
  side: "short",
  entryPrice: 100,
  stopPrice: 105,
  tp1Price: 95,
  tp2Price: 90,
};

// ─── Boundary equality ──────────────────────────────────────────────
//
// "Touched" must mean "filled" — operators expect that a wick to
// the exact stop price counts as a stop-out, not a hold.

describe("evaluateTradeInCandle — boundary equality", () => {
  it("LONG: low == stopPrice fires stop_hit", () => {
    const out = evaluateTradeInCandle({
      ...longBase,
      candle: { high: 102, low: 95, close: 99 },
    });
    expect(out.type).toBe("stop_hit");
  });

  it("LONG: high == tp1Price fires tp1_fill", () => {
    const out = evaluateTradeInCandle({
      ...longBase,
      candle: { high: 105, low: 99, close: 104 },
    });
    expect(out.type).toBe("tp1_fill");
  });

  it("LONG: high == tp2Price after tp1 fires tp2_hit", () => {
    const out = evaluateTradeInCandle({
      ...longBase,
      tp1Filled: true,
      stopPrice: 100, // BE stop after TP1
      remainingSize: 0.5,
      candle: { high: 110, low: 101, close: 109 },
    });
    expect(out.type).toBe("tp2_hit");
  });

  it("SHORT: high == stopPrice fires stop_hit", () => {
    const out = evaluateTradeInCandle({
      ...shortBase,
      candle: { high: 105, low: 96, close: 100 },
    });
    expect(out.type).toBe("stop_hit");
  });

  it("SHORT: low == tp1Price fires tp1_fill", () => {
    const out = evaluateTradeInCandle({
      ...shortBase,
      candle: { high: 100, low: 95, close: 96 },
    });
    expect(out.type).toBe("tp1_fill");
  });
});

// ─── Stop-first precedence ──────────────────────────────────────────
//
// On simultaneous hit (same candle pierces both stop and TP1),
// fill the stop. The execution model is pessimistic on purpose;
// this is the safer default for backtests and live ticks.

describe("evaluateTradeInCandle — stop-first precedence", () => {
  it("LONG: stop wins when wick pierces both stop and tp1", () => {
    const out = evaluateTradeInCandle({
      ...longBase,
      candle: { high: 106, low: 94, close: 105 },
    });
    expect(out.type).toBe("stop_hit");
    if (out.type === "stop_hit") {
      expect(out.fillPrice).toBe(95);
    }
  });

  it("LONG: stop wins when same candle would also fill tp2", () => {
    const out = evaluateTradeInCandle({
      ...longBase,
      tp1Filled: true,
      stopPrice: 100, // BE
      remainingSize: 0.5,
      candle: { high: 111, low: 99, close: 110 },
    });
    expect(out.type).toBe("stop_hit");
  });

  it("SHORT: stop wins when wick pierces both stop and tp1", () => {
    const out = evaluateTradeInCandle({
      ...shortBase,
      candle: { high: 106, low: 94, close: 95 },
    });
    expect(out.type).toBe("stop_hit");
    if (out.type === "stop_hit") {
      expect(out.fillPrice).toBe(105);
    }
  });
});

// ─── TP1 close-quantity math ────────────────────────────────────────

describe("evaluateTradeInCandle — TP1 partial-fill math", () => {
  it("closes exactly half of the ORIGINAL size at TP1", () => {
    const out = evaluateTradeInCandle({
      ...longBase,
      originalSize: 0.4,
      remainingSize: 0.4,
      candle: { high: 106, low: 99, close: 105 },
    });
    expect(out.type).toBe("tp1_fill");
    if (out.type === "tp1_fill") {
      expect(out.closedQty).toBeCloseTo(0.2, 9);
      expect(out.newStop).toBe(100);
    }
  });

  it("never closes more than what's still open (clamps to remainingSize)", () => {
    // Pathological: original 1.0, remaining only 0.3 (somehow already partially closed)
    const out = evaluateTradeInCandle({
      ...longBase,
      originalSize: 1,
      remainingSize: 0.3,
      candle: { high: 106, low: 99, close: 105 },
    });
    expect(out.type).toBe("tp1_fill");
    if (out.type === "tp1_fill") {
      expect(out.closedQty).toBeCloseTo(0.3, 9);
    }
  });

  it("BE stop moves to entry on TP1 fill (long)", () => {
    const out = evaluateTradeInCandle({
      ...longBase,
      entryPrice: 99.5,
      candle: { high: 106, low: 99, close: 105 },
    });
    if (out.type === "tp1_fill") {
      expect(out.newStop).toBe(99.5);
    } else {
      throw new Error("expected tp1_fill");
    }
  });

  it("BE stop moves to entry on TP1 fill (short)", () => {
    const out = evaluateTradeInCandle({
      ...shortBase,
      entryPrice: 100.5,
      candle: { high: 100, low: 95, close: 96 },
    });
    if (out.type === "tp1_fill") {
      expect(out.newStop).toBe(100.5);
    } else {
      throw new Error("expected tp1_fill");
    }
  });
});

// ─── Degenerate inputs ──────────────────────────────────────────────

describe("evaluateTradeInCandle — degenerate inputs", () => {
  it("holds when tp1Price is null and price would have hit it", () => {
    const out = evaluateTradeInCandle({
      ...longBase,
      tp1Price: null,
      candle: { high: 106, low: 99, close: 105 },
    });
    expect(out.type).toBe("hold");
  });

  it("holds when tp2Price is null after tp1Filled", () => {
    const out = evaluateTradeInCandle({
      ...longBase,
      tp1Filled: true,
      tp2Price: null,
      stopPrice: 100,
      remainingSize: 0.5,
      candle: { high: 115, low: 101, close: 114 },
    });
    expect(out.type).toBe("hold");
  });

  it("does not re-fill TP1 when tp1Filled is already true", () => {
    const out = evaluateTradeInCandle({
      ...longBase,
      tp1Filled: true,
      stopPrice: 100,
      remainingSize: 0.5,
      candle: { high: 106, low: 101, close: 105 },
    });
    expect(out.type).toBe("hold");
  });

  it("hold when candle stays inside the band", () => {
    const out = evaluateTradeInCandle({
      ...longBase,
      candle: { high: 102, low: 98, close: 101 },
    });
    expect(out.type).toBe("hold");
  });
});

// ─── Sequential-candle equity roll ──────────────────────────────────
//
// Drive a synthetic two-bar tape: bar 1 fills TP1, bar 2 fills TP2.
// Verify (a) the FSM gives a valid sequence of actions, (b) total
// realized PnL = +1R/2 + 2R/2 = 1.5R when both legs work as planned.

describe("evaluateTradeInCandle — equity roll across candles", () => {
  it("LONG: TP1 fill on bar 1, TP2 fill on bar 2 = 1.5R total", () => {
    const entry = 100;
    const stop = 95;
    const tp1 = 105; // 1R
    const tp2 = 110; // 2R
    const originalSize = 2;

    // Bar 1: hits TP1
    const a1 = evaluateTradeInCandle({
      side: "long",
      entryPrice: entry,
      stopPrice: stop,
      tp1Price: tp1,
      tp2Price: tp2,
      originalSize,
      remainingSize: originalSize,
      tp1Filled: false,
      candle: { high: 106, low: 99, close: 105 },
    });
    expect(a1.type).toBe("tp1_fill");
    if (a1.type !== "tp1_fill") throw new Error("not tp1_fill");
    const realizedAfterTp1 = (a1.fillPrice - entry) * a1.closedQty;
    expect(realizedAfterTp1).toBeCloseTo((105 - 100) * 1, 9); // half size = 1
    const remainingSize = originalSize - a1.closedQty;
    expect(remainingSize).toBeCloseTo(1, 9);

    // Bar 2: hits TP2 with stop already at BE
    const a2 = evaluateTradeInCandle({
      side: "long",
      entryPrice: entry,
      stopPrice: a1.newStop, // BE
      tp1Price: tp1,
      tp2Price: tp2,
      originalSize,
      remainingSize,
      tp1Filled: true,
      candle: { high: 111, low: 101, close: 110 },
    });
    expect(a2.type).toBe("tp2_hit");
    if (a2.type !== "tp2_hit") throw new Error("not tp2_hit");
    const realizedAfterTp2 = (a2.fillPrice - entry) * a2.closedQty;
    expect(realizedAfterTp2).toBeCloseTo((110 - 100) * 1, 9); // runner = 1

    // Trade-level R = full size × per-share risk. Half closed at +1R/share
    // contributes 0.5R; runner half at +2R/share contributes 1.0R; total 1.5R.
    const oneR = originalSize * (entry - stop);
    const totalR = (realizedAfterTp1 + realizedAfterTp2) / oneR;
    expect(totalR).toBeCloseTo(1.5, 9);
  });

  it("LONG: TP1 then BE stop sweep = 0.5R total (lock-in pattern)", () => {
    const entry = 100;
    const tp1 = 105;
    const originalSize = 2;

    const a1 = evaluateTradeInCandle({
      side: "long",
      entryPrice: entry,
      stopPrice: 95,
      tp1Price: tp1,
      tp2Price: 110,
      originalSize,
      remainingSize: originalSize,
      tp1Filled: false,
      candle: { high: 106, low: 99, close: 105 },
    });
    expect(a1.type).toBe("tp1_fill");
    if (a1.type !== "tp1_fill") throw new Error();
    const realized1 = (a1.fillPrice - entry) * a1.closedQty;

    const a2 = evaluateTradeInCandle({
      side: "long",
      entryPrice: entry,
      stopPrice: a1.newStop, // BE = 100
      tp1Price: tp1,
      tp2Price: 110,
      originalSize,
      remainingSize: originalSize - a1.closedQty,
      tp1Filled: true,
      candle: { high: 102, low: 99.5, close: 100 },
    });
    expect(a2.type).toBe("stop_hit");
    if (a2.type !== "stop_hit") throw new Error();
    const realized2 = (a2.fillPrice - entry) * a2.closedQty; // 0

    // Half closed at +1R/share = 0.5R; runner stopped at BE = 0R; total 0.5R.
    const oneR = originalSize * (entry - 95);
    const totalR = (realized1 + realized2) / oneR;
    expect(totalR).toBeCloseTo(0.5, 9);
  });

  it("SHORT: full lifecycle TP1 → TP2 mirrors long math", () => {
    const entry = 100;
    const stop = 105;
    const tp1 = 95;
    const tp2 = 90;
    const originalSize = 2;

    const a1 = evaluateTradeInCandle({
      side: "short",
      entryPrice: entry,
      stopPrice: stop,
      tp1Price: tp1,
      tp2Price: tp2,
      originalSize,
      remainingSize: originalSize,
      tp1Filled: false,
      candle: { high: 101, low: 94, close: 95 },
    });
    expect(a1.type).toBe("tp1_fill");
    if (a1.type !== "tp1_fill") throw new Error();
    const realized1 = (entry - a1.fillPrice) * a1.closedQty; // sign-flipped

    // Bar 2: clean down-move that reaches TP2 without ever touching the
    // BE stop at 100. (high: 101 would have tripped the BE stop because
    // for shorts, hitsStop = candle.high >= stopPrice, and stop-first
    // precedence would then take over.)
    const a2 = evaluateTradeInCandle({
      side: "short",
      entryPrice: entry,
      stopPrice: a1.newStop, // BE = 100
      tp1Price: tp1,
      tp2Price: tp2,
      originalSize,
      remainingSize: originalSize - a1.closedQty,
      tp1Filled: true,
      candle: { high: 99, low: 89, close: 90 },
    });
    expect(a2.type).toBe("tp2_hit");
    if (a2.type !== "tp2_hit") throw new Error();
    const realized2 = (entry - a2.fillPrice) * a2.closedQty;

    const oneR = originalSize * (stop - entry);
    const totalR = (realized1 + realized2) / oneR;
    expect(totalR).toBeCloseTo(1.5, 9);
  });
});

// ─── Discriminated-union exhaustiveness ─────────────────────────────

describe("evaluateTradeInCandle — return type integrity", () => {
  it("only ever returns one of {hold, tp1_fill, stop_hit, tp2_hit}", () => {
    const known = new Set(["hold", "tp1_fill", "stop_hit", "tp2_hit"]);
    const cases: InCandleInputs[] = [
      { ...longBase, candle: { high: 101, low: 99, close: 100 } }, // hold
      { ...longBase, candle: { high: 106, low: 99, close: 105 } }, // tp1
      { ...longBase, candle: { high: 102, low: 94, close: 96 } }, // stop
      {
        ...longBase,
        tp1Filled: true,
        stopPrice: 100,
        remainingSize: 0.5,
        candle: { high: 111, low: 101, close: 110 },
      }, // tp2
    ];
    for (const c of cases) {
      const out = evaluateTradeInCandle(c);
      expect(known.has(out.type)).toBe(true);
    }
  });
});
