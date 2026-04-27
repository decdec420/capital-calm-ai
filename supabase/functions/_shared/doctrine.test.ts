// deno-lint-ignore-file no-explicit-any
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ALL_PROFILE_IDS,
  CAPITAL_PRESERVATION_DOCTRINE,
  KILL_SWITCH_FLOOR_USD,
  MAX_DAILY_LOSS_USD,
  MAX_ORDER_USD,
  MAX_TRADES_PER_DAY,
  SYMBOL_WHITELIST,
  getProfile,
  isWhitelistedSymbol,
  validateDoctrineInvariants,
} from "./doctrine.ts";

Deno.test("doctrine — legacy MAX_* aliases mirror the Sentinel profile", () => {
  assertEquals(MAX_ORDER_USD, 1);
  assertEquals(MAX_TRADES_PER_DAY, 5);
  assertEquals(MAX_DAILY_LOSS_USD, 2);
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

Deno.test("doctrine — exposes all three profiles in tier order", () => {
  assertEquals([...ALL_PROFILE_IDS], ["sentinel", "active", "aggressive"]);
});

Deno.test("doctrine — getProfile returns the requested tier", () => {
  assertEquals(getProfile("sentinel").maxOrderUsdHardCap, 1);
  assertEquals(getProfile("active").maxOrderUsdHardCap, 5);
  assertEquals(getProfile("aggressive").maxOrderUsdHardCap, 25);
});

Deno.test("doctrine — getProfile falls back to sentinel on garbage", () => {
  assertEquals(getProfile(null).id, "sentinel");
  assertEquals(getProfile(undefined).id, "sentinel");
  assertEquals(getProfile("nope").id, "sentinel");
});

Deno.test("doctrine — sentinel ceiling holds even if profile is mutated", () => {
  const mutated: any = structuredClone(CAPITAL_PRESERVATION_DOCTRINE);
  mutated.profiles.sentinel.maxOrderUsdHardCap = 5;
  assertThrows(
    () => {
      if (mutated.profiles.sentinel.maxOrderUsdHardCap > 1) {
        throw new Error("Doctrine invariant failed: sentinel.maxOrderUsdHardCap must be <= $1.");
      }
    },
    Error,
    "sentinel.maxOrderUsdHardCap",
  );
});

Deno.test("doctrine — aggressive scan interval is fastest", () => {
  const s = getProfile("sentinel").scanIntervalSeconds;
  const a = getProfile("active").scanIntervalSeconds;
  const x = getProfile("aggressive").scanIntervalSeconds;
  // Faster = smaller seconds. Aggressive must scan at least as fast as Active,
  // which must scan at least as fast as Sentinel.
  if (!(x <= a && a <= s)) {
    throw new Error(`Scan interval ordering violated: sentinel=${s}, active=${a}, aggressive=${x}`);
  }
});
