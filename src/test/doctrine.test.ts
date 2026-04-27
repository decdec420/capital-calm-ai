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
} from "../../supabase/functions/_shared/doctrine";

describe("doctrine constants", () => {
  it("enforces the capital-preservation hard caps", () => {
    expect(MAX_ORDER_USD).toBe(1);
    expect(MAX_TRADES_PER_DAY).toBe(5);
    expect(MAX_DAILY_LOSS_USD).toBe(1);
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
    expect(CAPITAL_PRESERVATION_DOCTRINE.hardRules.tpLadder.tp1R).toBe(1);
    expect(CAPITAL_PRESERVATION_DOCTRINE.hardRules.tpLadder.tp2R).toBe(2);
    expect(CAPITAL_PRESERVATION_DOCTRINE.hardRules.tpLadder.tp1ClosesFraction).toBe(0.5);
    expect(CAPITAL_PRESERVATION_DOCTRINE.hardRules.tpLadder.moveStopToBreakevenAtTp1).toBe(true);
  });
});
