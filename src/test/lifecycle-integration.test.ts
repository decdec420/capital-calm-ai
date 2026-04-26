import { describe, it, expect } from "vitest";
import {
  validateDoctrineInvariants,
  MAX_ORDER_USD,
  KILL_SWITCH_FLOOR_USD,
  isWhitelistedSymbol,
} from "../../supabase/functions/_shared/doctrine";
import {
  evaluateRiskGates,
  anyRefusal,
  type RiskContext,
} from "../../supabase/functions/_shared/risk";
import { clampSize } from "../../supabase/functions/_shared/sizing";
import {
  appendTransition,
  evaluateTradeInCandle,
  transitionSignal,
  transitionTrade,
  type LifecycleTransition,
} from "../../supabase/functions/_shared/lifecycle";

// ============================================================
// Full-lifecycle integration test (P4-B)
// ------------------------------------------------------------
// Stitches every shared module together — doctrine → sizing →
// risk → FSM → in-candle MTM — and asserts the chain produces a
// coherent end-to-end state. This is the closest we get to a
// "would the system have done the right thing?" test without
// spinning up a real Supabase. Every individual unit has its own
// suite; this one exists to catch composition bugs.
// ============================================================

describe("full trade lifecycle — happy path", () => {
  it("signal → gate → size clamp → trade → TP1 → TP2 → archived", () => {
    // Doctrine sanity (cold-start invariant).
    expect(() => validateDoctrineInvariants()).not.toThrow();
    expect(MAX_ORDER_USD).toBe(1);
    expect(KILL_SWITCH_FLOOR_USD).toBeGreaterThan(0);

    // ─── 1. Symbol + risk context ────────────────────────────
    const symbol = "BTC-USD";
    expect(isWhitelistedSymbol(symbol)).toBe(true);

    const equityUsd = 100; // well above the kill-switch floor
    const ctx: RiskContext = {
      symbol,
      equityUsd,
      dailyRealizedPnlUsd: 0,
      dailyTradeCount: 0,
      killSwitchEngaged: false,
      botStatus: "running",
      hasOpenPosition: false,
      hasPendingSignal: false,
    };
    const gateReasons = evaluateRiskGates(ctx);
    expect(anyRefusal(gateReasons)).toBe(false);
    expect(gateReasons).toEqual([]);

    // ─── 2. Sizing clamp ─────────────────────────────────────
    const proposedQuoteUsd = 5; // AI proposed $5; doctrine caps at $1
    const symbolPrice = 60_000;
    const clamp = clampSize({
      proposedQuoteUsd,
      equityUsd,
      symbolPrice,
      symbol,
    });
    expect(clamp.blocked).toBe(false);
    expect(clamp.sizeUsd).toBe(MAX_ORDER_USD);
    expect(clamp.qty).toBeGreaterThan(0);
    expect(clamp.qty).toBeLessThan(0.001); // ≈0.0000167 BTC at $60k

    // ─── 3. Signal FSM: proposed → approved → executed ──────
    const proposedTransition = transitionSignal("proposed", "approved", {
      actor: "engine",
      reason: "Auto-approved (autonomous, conf 90%)",
    });
    expect(proposedTransition.ok).toBe(true);

    const executedTransition = transitionSignal("approved", "executed", {
      actor: "engine",
      reason: "Auto-approved (autonomous, conf 90%)",
    });
    expect(executedTransition.ok).toBe(true);

    const signalTransitions: LifecycleTransition[] = appendTransition(
      [proposedTransition.transition!],
      executedTransition.transition!,
    );
    expect(signalTransitions).toHaveLength(2);
    expect(signalTransitions[0].phase).toBe("approved");
    expect(signalTransitions[1].phase).toBe("executed");

    // ─── 4. Trade FSM seed: entered ──────────────────────────
    const tradeEntered = transitionTrade("entered", "entered", {
      actor: "engine",
      reason: "Auto-approved (autonomous)",
    });
    // Note: "entered → entered" is treated as a no-op seed; the FSM
    // accepts it via the same code path that real transitions use.
    expect(tradeEntered.ok).toBe(false); // self-transition is illegal …
    // … which is by design. We seed the lifecycle with a manual
    // transition entry instead.
    const seedTransition: LifecycleTransition = {
      phase: "entered",
      at: new Date().toISOString(),
      by: "engine",
      reason: "Auto-approved (autonomous)",
    };
    let tradeTransitions: LifecycleTransition[] = [seedTransition];
    let tradePhase: "entered" | "monitored" | "tp1_hit" | "exited" | "archived" =
      "entered";

    // ─── 5. In-candle MTM: TP1 fills on first candle ─────────
    const entry = symbolPrice;
    const stop = entry * 0.984; // ~1.6% stop
    const tp1 = entry * 1.016; // 1R
    const tp2 = entry * 1.032; // 2R
    const originalSize = clamp.qty;

    const c1 = evaluateTradeInCandle({
      side: "long",
      entryPrice: entry,
      stopPrice: stop,
      tp1Price: tp1,
      tp2Price: tp2,
      originalSize,
      remainingSize: originalSize,
      tp1Filled: false,
      candle: { high: tp1 + 1, low: entry, close: tp1 },
    });
    expect(c1.type).toBe("tp1_fill");
    if (c1.type !== "tp1_fill") throw new Error("expected tp1_fill");

    const tp1Step = transitionTrade(tradePhase, "tp1_hit", {
      actor: "engine",
      reason: `TP1 filled @ $${c1.fillPrice.toFixed(2)}`,
    });
    expect(tp1Step.ok).toBe(true);
    tradeTransitions = appendTransition(tradeTransitions, tp1Step.transition!);
    tradePhase = "tp1_hit";

    const realizedAfterTp1 = (c1.fillPrice - entry) * c1.closedQty;
    const remainingSize = originalSize - c1.closedQty;
    expect(remainingSize).toBeCloseTo(originalSize / 2, 9);

    // ─── 6. Second candle: TP2 fills with BE stop ────────────
    const c2 = evaluateTradeInCandle({
      side: "long",
      entryPrice: entry,
      stopPrice: c1.newStop,
      tp1Price: tp1,
      tp2Price: tp2,
      originalSize,
      remainingSize,
      tp1Filled: true,
      candle: { high: tp2 + 1, low: entry + 0.5, close: tp2 },
    });
    expect(c2.type).toBe("tp2_hit");
    if (c2.type !== "tp2_hit") throw new Error("expected tp2_hit");

    const exitStep = transitionTrade(tradePhase, "exited", {
      actor: "engine",
      reason: `TP2 filled @ $${c2.fillPrice.toFixed(2)}`,
    });
    expect(exitStep.ok).toBe(true);
    tradeTransitions = appendTransition(tradeTransitions, exitStep.transition!);
    tradePhase = "exited";

    const realizedAfterTp2 = (c2.fillPrice - entry) * c2.closedQty;
    const totalRealized = realizedAfterTp1 + realizedAfterTp2;

    // The trade should clear ~1.5R total: half at 1R, half at 2R.
    const oneR = (entry - stop) * originalSize; // R as USD
    const realizedR = totalRealized / oneR;
    expect(realizedR).toBeCloseTo(1.5, 6);

    // ─── 7. Archive ──────────────────────────────────────────
    const archiveStep = transitionTrade(tradePhase, "archived", {
      actor: "engine",
      reason: "Closed and journalled",
    });
    expect(archiveStep.ok).toBe(true);
    tradeTransitions = appendTransition(
      tradeTransitions,
      archiveStep.transition!,
    );

    // ─── 8. Final assertions ─────────────────────────────────
    const phases = tradeTransitions.map((t) => t.phase);
    expect(phases).toEqual(["entered", "tp1_hit", "exited", "archived"]);
    expect(tradeTransitions.every((t) => typeof t.at === "string")).toBe(true);
  });
});

describe("full trade lifecycle — refusal paths", () => {
  it("doctrine refuses an off-whitelist symbol before risk runs", () => {
    expect(isWhitelistedSymbol("DOGE-USD")).toBe(false);
    const clamp = clampSize({
      proposedQuoteUsd: 1,
      equityUsd: 100,
      symbolPrice: 0.1,
      symbol: "DOGE-USD",
    });
    expect(clamp.blocked).toBe(true);
    expect(clamp.clampedBy[0].code).toBe("DOCTRINE_SYMBOL_NOT_ALLOWED");
  });

  it("kill-switch halts the risk gate before any sizing happens", () => {
    const reasons = evaluateRiskGates({
      symbol: "BTC-USD",
      equityUsd: 100,
      dailyRealizedPnlUsd: 0,
      dailyTradeCount: 0,
      killSwitchEngaged: true,
      botStatus: "running",
      hasOpenPosition: false,
      hasPendingSignal: false,
    });
    expect(anyRefusal(reasons)).toBe(true);
    expect(reasons.some((r) => r.code === "KILL_SWITCH")).toBe(true);
  });

  it("daily loss cap halts even when other gates would clear", () => {
    const reasons = evaluateRiskGates({
      symbol: "BTC-USD",
      equityUsd: 100,
      dailyRealizedPnlUsd: -1, // exactly at cap
      dailyTradeCount: 0,
      killSwitchEngaged: false,
      botStatus: "running",
      hasOpenPosition: false,
      hasPendingSignal: false,
    });
    expect(reasons.some((r) => r.code === "DAILY_LOSS_CAP")).toBe(true);
  });

  it("FSM refuses illegal phase jump (proposed → executed without approve)", () => {
    const result = transitionSignal("proposed", "executed");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Illegal/);
  });
});

describe("full trade lifecycle — adverse paths", () => {
  it("losing trade: stop fires first candle, no TP1 ever", () => {
    const entry = 60_000;
    const stop = entry * 0.984;
    const tp1 = entry * 1.016;
    const tp2 = entry * 1.032;
    const originalSize = 0.0000167;

    // Candle that gaps down — low pierces the stop, but the same
    // candle never traded above tp1 either.
    const c = evaluateTradeInCandle({
      side: "long",
      entryPrice: entry,
      stopPrice: stop,
      tp1Price: tp1,
      tp2Price: tp2,
      originalSize,
      remainingSize: originalSize,
      tp1Filled: false,
      candle: { high: entry + 50, low: stop - 1, close: stop },
    });
    expect(c.type).toBe("stop_hit");
    if (c.type !== "stop_hit") throw new Error("expected stop_hit");

    const realized = (c.fillPrice - entry) * c.closedQty;
    expect(realized).toBeLessThan(0);

    const oneR = (entry - stop) * originalSize;
    const realizedR = realized / oneR;
    expect(realizedR).toBeCloseTo(-1, 4);
  });

  it("breakeven on adverse spike after TP1: net = +0.5R", () => {
    const entry = 100;
    const stop = 95;
    const tp1 = 105;
    const tp2 = 110;
    const originalSize = 2;

    // Candle 1: TP1 fills, BE stop set.
    const c1 = evaluateTradeInCandle({
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
    expect(c1.type).toBe("tp1_fill");
    if (c1.type !== "tp1_fill") throw new Error();
    const r1 = (c1.fillPrice - entry) * c1.closedQty;

    // Candle 2: BE stop hit.
    const c2 = evaluateTradeInCandle({
      side: "long",
      entryPrice: entry,
      stopPrice: c1.newStop,
      tp1Price: tp1,
      tp2Price: tp2,
      originalSize,
      remainingSize: originalSize - c1.closedQty,
      tp1Filled: true,
      candle: { high: 102, low: entry, close: entry },
    });
    expect(c2.type).toBe("stop_hit");
    if (c2.type !== "stop_hit") throw new Error();
    const r2 = (c2.fillPrice - entry) * c2.closedQty;

    const oneR = (entry - stop) * originalSize;
    const totalR = (r1 + r2) / oneR;
    expect(totalR).toBeCloseTo(0.5, 9);
  });
});
