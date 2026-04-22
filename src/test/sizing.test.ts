import { describe, it, expect } from "vitest";
import { clampSize } from "../../supabase/functions/_shared/sizing";

describe("clampSize", () => {
  const baseInput = {
    proposedQuoteUsd: 1,
    equityUsd: 100,
    symbolPrice: 50_000,
    symbol: "BTC-USD",
  };

  it("blocks off-whitelist symbols", () => {
    const out = clampSize({ ...baseInput, symbol: "DOGE-USD" });
    expect(out.blocked).toBe(true);
    expect(out.sizeUsd).toBe(0);
    expect(out.clampedBy[0].code).toBe("DOCTRINE_SYMBOL_NOT_ALLOWED");
  });

  it("clamps a proposed $5 down to $1", () => {
    const out = clampSize({ ...baseInput, proposedQuoteUsd: 5 });
    expect(out.blocked).toBe(false);
    expect(out.sizeUsd).toBe(1);
    expect(out.clampedBy.some((r) => r.code === "DOCTRINE_MAX_ORDER")).toBe(true);
  });

  it("passes a within-cap $0.75 order through unchanged", () => {
    const out = clampSize({ ...baseInput, proposedQuoteUsd: 0.75 });
    expect(out.blocked).toBe(false);
    expect(out.sizeUsd).toBe(0.75);
    expect(out.clampedBy.length).toBe(0);
  });

  it("blocks when equity - order would drop below the $8 floor", () => {
    const out = clampSize({ ...baseInput, equityUsd: 8.5, proposedQuoteUsd: 1 });
    expect(out.blocked).toBe(true);
    expect(out.clampedBy[0].code).toBe("DOCTRINE_KILL_SWITCH_FLOOR");
  });

  it("blocks non-positive proposed size", () => {
    const out = clampSize({ ...baseInput, proposedQuoteUsd: 0 });
    expect(out.blocked).toBe(true);
    expect(out.clampedBy[0].code).toBe("DOCTRINE_INVALID_SIZE");
  });

  it("blocks non-positive price", () => {
    const out = clampSize({ ...baseInput, symbolPrice: -1 });
    expect(out.blocked).toBe(true);
    expect(out.clampedBy[0].code).toBe("DOCTRINE_INVALID_SIZE");
  });

  it("blocks when clamped size is below the exchange minimum", () => {
    // Proposing $0.10 with minOrderUsd=0.25 should block.
    const out = clampSize({ ...baseInput, proposedQuoteUsd: 0.10, minOrderUsd: 0.25 });
    expect(out.blocked).toBe(true);
    expect(out.clampedBy.some((r) => r.code === "DOCTRINE_QTY_TOO_SMALL")).toBe(true);
  });

  it("computes the correct qty at Coinbase precision", () => {
    const out = clampSize({ ...baseInput, proposedQuoteUsd: 1, symbolPrice: 100_000 });
    expect(out.sizeUsd).toBe(1);
    // qty = 1/100_000 = 1e-5, rounded to 1e-8 precision.
    expect(out.qty).toBeCloseTo(0.00001, 8);
  });
});
