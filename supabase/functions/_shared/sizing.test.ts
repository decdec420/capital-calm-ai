import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clampSize } from "./sizing.ts";

Deno.test("sizing — rejects non-whitelisted symbol", () => {
  const r = clampSize({
    proposedQuoteUsd: 0.5,
    equityUsd: 100,
    symbolPrice: 50_000,
    symbol: "DOGE-USD",
  });
  assertEquals(r.blocked, true);
  assertEquals(r.clampedBy[0].code, "DOCTRINE_SYMBOL_NOT_ALLOWED");
});

Deno.test("sizing — clamps $5 proposal to $1 cap", () => {
  const r = clampSize({
    proposedQuoteUsd: 5,
    equityUsd: 100,
    symbolPrice: 50_000,
    symbol: "BTC-USD",
  });
  assertEquals(r.blocked, false);
  assertEquals(r.sizeUsd, 1);
  assertEquals(
    r.clampedBy.some((x) => x.code === "DOCTRINE_MAX_ORDER"),
    true,
  );
});

Deno.test("sizing — blocks when order drops equity below kill-switch floor", () => {
  const r = clampSize({
    proposedQuoteUsd: 1,
    equityUsd: 8.5, // $8.50 - $1 = $7.50 < $8 floor
    symbolPrice: 50_000,
    symbol: "BTC-USD",
  });
  assertEquals(r.blocked, true);
  assertEquals(r.clampedBy[0].code, "DOCTRINE_KILL_SWITCH_FLOOR");
});

Deno.test("sizing — rejects non-positive proposed size", () => {
  const r = clampSize({
    proposedQuoteUsd: 0,
    equityUsd: 100,
    symbolPrice: 50_000,
    symbol: "BTC-USD",
  });
  assertEquals(r.blocked, true);
  assertEquals(r.clampedBy[0].code, "DOCTRINE_INVALID_SIZE");
});

Deno.test("sizing — happy path produces sensible qty", () => {
  const r = clampSize({
    proposedQuoteUsd: 1,
    equityUsd: 100,
    symbolPrice: 50_000,
    symbol: "BTC-USD",
  });
  assertEquals(r.blocked, false);
  assertEquals(r.sizeUsd, 1);
  // 1 / 50_000 = 0.00002, rounded to 8 decimals
  assertEquals(r.qty, 0.00002);
});

Deno.test("sizing — rejects zero-qty residuals (price too high for min order)", () => {
  const r = clampSize({
    proposedQuoteUsd: 0.1,
    equityUsd: 100,
    symbolPrice: 50_000,
    symbol: "BTC-USD",
    minOrderUsd: 0.25,
  });
  assertEquals(r.blocked, true);
  assertEquals(r.clampedBy.some((x) => x.code === "DOCTRINE_QTY_TOO_SMALL"), true);
});
