import { describe, it, expect } from "vitest";
import { evaluateRiskGates, anyRefusal, isRefusal } from "../../supabase/functions/_shared/risk";

function baseCtx(overrides: Partial<Parameters<typeof evaluateRiskGates>[0]> = {}) {
  return {
    symbol: "BTC-USD",
    equityUsd: 100,
    dailyRealizedPnlUsd: 0,
    dailyTradeCount: 0,
    killSwitchEngaged: false,
    botStatus: "running",
    hasOpenPosition: false,
    hasPendingSignal: false,
    ...overrides,
  };
}

describe("risk gate stack", () => {
  it("returns empty reasons for a clean context", () => {
    const reasons = evaluateRiskGates(baseCtx());
    expect(anyRefusal(reasons)).toBe(false);
    expect(reasons.length).toBe(0);
  });

  it("halts on engaged kill switch", () => {
    const reasons = evaluateRiskGates(baseCtx({ killSwitchEngaged: true }));
    expect(reasons.some((r) => r.code === "KILL_SWITCH" && r.severity === "halt")).toBe(true);
  });

  it("halts on bot halted or paused", () => {
    const halted = evaluateRiskGates(baseCtx({ botStatus: "halted" }));
    expect(halted.some((r) => r.code === "BOT_HALTED")).toBe(true);
    const paused = evaluateRiskGates(baseCtx({ botStatus: "paused" }));
    expect(paused.some((r) => r.code === "BOT_PAUSED")).toBe(true);
  });

  it("halts when equity is below the kill-switch floor", () => {
    const reasons = evaluateRiskGates(baseCtx({ equityUsd: 5 }));
    expect(reasons.some((r) => r.code === "BALANCE_FLOOR" && r.severity === "halt")).toBe(true);
  });

  it("halts at the daily trade cap", () => {
    const reasons = evaluateRiskGates(baseCtx({ dailyTradeCount: 5 }));
    expect(reasons.some((r) => r.code === "TRADE_COUNT_CAP")).toBe(true);
  });

  it("halts when daily realized loss hits the $2 cap", () => {
    const reasons = evaluateRiskGates(baseCtx({ dailyRealizedPnlUsd: -2 }));
    expect(reasons.some((r) => r.code === "DAILY_LOSS_CAP")).toBe(true);
  });

  it("ignores positive daily PnL", () => {
    const reasons = evaluateRiskGates(baseCtx({ dailyRealizedPnlUsd: 10 }));
    expect(reasons.some((r) => r.code === "DAILY_LOSS_CAP")).toBe(false);
  });

  it("blocks new signal when a position is already open on the symbol", () => {
    const reasons = evaluateRiskGates(baseCtx({ hasOpenPosition: true }));
    const r = reasons.find((r) => r.code === "OPEN_POSITION");
    expect(r).toBeDefined();
    expect(isRefusal(r!)).toBe(true);
  });

  it("blocks new signal when one is already pending", () => {
    const reasons = evaluateRiskGates(baseCtx({ hasPendingSignal: true }));
    expect(reasons.some((r) => r.code === "PENDING_SIGNAL")).toBe(true);
  });

  it("skips (not halts) on wide spread", () => {
    const reasons = evaluateRiskGates(baseCtx({ bid: 100, ask: 102 }));
    const r = reasons.find((r) => r.code === "SPREAD_TOO_WIDE");
    expect(r).toBeDefined();
    expect(r!.severity).toBe("skip");
  });

  it("skips on stale candle data", () => {
    const reasons = evaluateRiskGates(
      baseCtx({
        latestCandleEndedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
    );
    expect(reasons.some((r) => r.code === "STALE_DATA")).toBe(true);
  });

  it("blocks off-whitelist symbols and short-circuits", () => {
    const reasons = evaluateRiskGates(baseCtx({ symbol: "DOGE-USD", killSwitchEngaged: true }));
    // Only the whitelist reason should emit; no additional halts.
    expect(reasons.length).toBe(1);
    expect(reasons[0].code).toBe("DOCTRINE_SYMBOL_NOT_ALLOWED");
  });

  it("halts on blocked guardrail", () => {
    const reasons = evaluateRiskGates(
      baseCtx({ guardrails: [{ label: "Balance floor", level: "blocked", utilization: 1 }] }),
    );
    expect(reasons.some((r) => r.code === "GUARDRAIL_BLOCKED")).toBe(true);
  });
});
