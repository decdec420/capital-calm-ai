// Parallel Vitest coverage of the Deno _shared modules. Imports the
// source of truth directly so any doctrine drift breaks both test
// runners simultaneously.
import { describe, it, expect } from "vitest";
import {
  CAPITAL_PRESERVATION_DOCTRINE,
  MAX_ORDER_USD,
  MAX_TRADES_PER_DAY,
  MAX_DAILY_LOSS_USD,
  KILL_SWITCH_FLOOR_USD,
  SYMBOL_WHITELIST,
  isWhitelistedSymbol,
  validateDoctrineInvariants,
  getProfile,
  ALL_PROFILE_IDS,
} from "../../supabase/functions/_shared/doctrine";

describe("doctrine constants", () => {
  it("legacy MAX_* aliases mirror the Sentinel profile", () => {
    expect(MAX_ORDER_USD).toBe(1);
    expect(MAX_TRADES_PER_DAY).toBe(5);
    expect(MAX_DAILY_LOSS_USD).toBe(2);
    expect(KILL_SWITCH_FLOOR_USD).toBe(8);
  });

  it("exposes the three-asset whitelist", () => {
    expect([...SYMBOL_WHITELIST]).toEqual(["BTC-USD", "ETH-USD", "SOL-USD"]);
  });

  it("rejects off-whitelist symbols", () => {
    expect(isWhitelistedSymbol("BTC-USD")).toBe(true);
    expect(isWhitelistedSymbol("DOGE-USD")).toBe(false);
    expect(isWhitelistedSymbol("")).toBe(false);
  });

  it("validates invariants without throwing", () => {
    expect(() => validateDoctrineInvariants()).not.toThrow();
  });

  it("keeps principles flagged true", () => {
    expect(CAPITAL_PRESERVATION_DOCTRINE.principles.liveRequiresApproval).toBe(true);
    expect(CAPITAL_PRESERVATION_DOCTRINE.principles.noTradeIsValid).toBe(true);
    expect(CAPITAL_PRESERVATION_DOCTRINE.principles.preserveCapitalFirst).toBe(true);
  });

  it("defines the TP1 ladder (half-close at 1R, runner to 2R)", () => {
    const tp = CAPITAL_PRESERVATION_DOCTRINE.globalRules.tpLadder;
    expect(tp.tp1R).toBe(1);
    expect(tp.tp2R).toBe(2);
    expect(tp.tp1ClosesFraction).toBe(0.5);
    expect(tp.moveStopToBreakevenAtTp1).toBe(true);
  });
});

describe("trading profiles", () => {
  it("exposes all three profile ids", () => {
    expect([...ALL_PROFILE_IDS]).toEqual(["sentinel", "active", "aggressive"]);
  });

  it("orders profiles from least to most permissive", () => {
    const s = getProfile("sentinel");
    const a = getProfile("active");
    const x = getProfile("aggressive");
    expect(s.maxOrderUsdHardCap).toBeLessThanOrEqual(a.maxOrderUsdHardCap);
    expect(a.maxOrderUsdHardCap).toBeLessThanOrEqual(x.maxOrderUsdHardCap);
    expect(s.maxDailyTradesHardCap).toBeLessThanOrEqual(a.maxDailyTradesHardCap);
    expect(a.maxDailyTradesHardCap).toBeLessThanOrEqual(x.maxDailyTradesHardCap);
    expect(s.scanIntervalSeconds).toBeGreaterThanOrEqual(a.scanIntervalSeconds);
    expect(a.scanIntervalSeconds).toBeGreaterThanOrEqual(x.scanIntervalSeconds);
  });

  it("falls back to sentinel for unknown ids", () => {
    expect(getProfile(null).id).toBe("sentinel");
    expect(getProfile(undefined).id).toBe("sentinel");
    expect(getProfile("garbage").id).toBe("sentinel");
  });

  it("aggressive caps stay within hard ceilings", () => {
    const x = getProfile("aggressive");
    expect(x.maxOrderUsdHardCap).toBeLessThanOrEqual(100);
    expect(x.maxDailyTradesHardCap).toBeLessThanOrEqual(50);
    expect(x.maxDailyLossUsdHardCap).toBeLessThanOrEqual(100);
  });
});
