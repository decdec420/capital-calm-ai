import { describe, expect, it } from "vitest";
import { evaluateQuietMode, shouldEmitQuietModeEvent } from "@/lib/quiet-mode";

const now = new Date("2026-05-13T12:00:00.000Z");

const idleBase = {
  now,
  openPositionsCount: 0,
  pendingSignalsCount: 0,
  openCriticalIncidentsCount: 0,
  liveTradingEnabled: false,
  brokerExposureKnown: true,
  marketDataStaleBlocksTrading: false,
  bot: "running",
  recentSignalActivityAt: "2026-05-13T10:00:00.000Z",
  recentMarketMomentumAt: "2026-05-13T11:50:00.000Z",
  recentMarketMomentumMagnitude: 0.1,
  recentNewsAt: "2026-05-13T08:00:00.000Z",
};

describe("quiet mode policy", () => {
  it("activates when there are no open positions, pending signals, critical incidents, or fresh pressure", () => {
    const decision = evaluateQuietMode(idleBase);
    expect(decision.mode).toBe("quiet");
    expect(decision.shouldSkipHeavyAi).toBe(true);
    expect(decision.shouldPreserveSafetyChecks).toBe(true);
    expect(decision.reasonCodes).toEqual(expect.arrayContaining([
      "no_open_positions",
      "no_pending_signals",
      "no_critical_incidents",
      "paper_or_non_live_mode",
      "no_recent_signal_activity",
      "no_fresh_momentum_pressure",
      "no_recent_news_pressure",
    ]));
  });

  it("does not activate with open positions", () => {
    const decision = evaluateQuietMode({ ...idleBase, openPositionsCount: 1 });
    expect(decision.mode).toBe("normal");
    expect(decision.reasonCodes).toContain("open_positions");
  });

  it("does not activate with pending signals", () => {
    const decision = evaluateQuietMode({ ...idleBase, pendingSignalsCount: 1 });
    expect(decision.mode).toBe("normal");
    expect(decision.reasonCodes).toContain("pending_signals");
  });

  it("does not activate with critical incidents", () => {
    const decision = evaluateQuietMode({ ...idleBase, openCriticalIncidentsCount: 1 });
    expect(decision.mode).toBe("normal");
    expect(decision.reasonCodes).toContain("critical_incidents_open");
  });

  it("does not activate in live mode", () => {
    const decision = evaluateQuietMode({ ...idleBase, liveTradingEnabled: true });
    expect(decision.mode).toBe("normal");
    expect(decision.reasonCodes).toContain("live_mode_active");
  });

  it("skips/defer heavy AI only and preserves safety checks", () => {
    const decision = evaluateQuietMode(idleBase);
    expect(decision.shouldSkipHeavyAi).toBe(true);
    expect(decision.shouldPreserveSafetyChecks).toBe(true);
    expect(decision.recommendedCadenceSeconds.signalEngine).toBeGreaterThan(60);
  });

  it("dedupes quiet-mode events to prevent per-minute spam", () => {
    expect(shouldEmitQuietModeEvent("2026-05-13T11:50:00.000Z", now)).toBe(false);
    expect(shouldEmitQuietModeEvent("2026-05-13T11:40:00.000Z", now)).toBe(true);
    expect(shouldEmitQuietModeEvent(null, now)).toBe(true);
  });
});
