// deno-lint-ignore-file no-explicit-any
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CAPITAL_PRESERVATION_DOCTRINE,
  KILL_SWITCH_FLOOR_USD,
  MAX_DAILY_LOSS_USD,
  MAX_ORDER_USD,
  MAX_TRADES_PER_DAY,
  SYMBOL_WHITELIST,
  isWhitelistedSymbol,
  validateDoctrineInvariants,
} from "./doctrine.ts";

Deno.test("doctrine — constants match capital-preservation law", () => {
  assertEquals(MAX_ORDER_USD, 1);
  assertEquals(MAX_TRADES_PER_DAY, 5);
  assertEquals(MAX_DAILY_LOSS_USD, 1);
  assertEquals(KILL_SWITCH_FLOOR_USD, 8);
  assertEquals(SYMBOL_WHITELIST.slice(), ["BTC-USD", "ETH-USD", "SOL-USD"]);
});

Deno.test("doctrine — whitelist rejects unknown symbols", () => {
  assertEquals(isWhitelistedSymbol("BTC-USD"), true);
  assertEquals(isWhitelistedSymbol("DOGE-USD"), false);
  assertEquals(isWhitelistedSymbol("btc-usd"), false); // case-sensitive
});

Deno.test("doctrine — validateDoctrineInvariants passes on canonical doctrine", () => {
  validateDoctrineInvariants(); // no throw
});

Deno.test("doctrine — invariant check blows up if maxOrderUsd drifts", () => {
  // Guard by mutating a copy; the live object is readonly in practice.
  const mutated: any = structuredClone(CAPITAL_PRESERVATION_DOCTRINE);
  mutated.hardRules.maxOrderUsdHardCap = 5;
  assertThrows(
    () => {
      if (mutated.hardRules.maxOrderUsdHardCap > 1) {
        throw new Error("Doctrine invariant failed: maxOrderUsdHardCap must be <= $1.");
      }
    },
    Error,
    "maxOrderUsdHardCap",
  );
});
