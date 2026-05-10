import { describe, it, expect } from "vitest";
import {
  computeTradingDecisionSnapshot,
  BRAIN_TRUST_STALE_SECONDS,
  TAYLOR_STALE_SECONDS,
  type TradingDecisionSnapshotInput,
} from "@/lib/trading-decision-snapshot";
import type { SystemState, StrategyVersion, Alert } from "@/lib/domain-types";
import type { MarketIntelligence } from "@/hooks/useMarketIntelligence";

const NOW_MS = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

function freshSnapshotRanAt(): string {
  return new Date(NOW_MS - 60_000).toISOString(); // 1 min ago
}

function baseSystem(overrides: Partial<SystemState> = {}): SystemState {
  return {
    id: "s1",
    mode: "paper",
    bot: "running",
    brokerConnection: "connected",
    dataFeed: "connected",
    killSwitchEngaged: false,
    liveTradingEnabled: false,
    uptimeHours: 1,
    lastHeartbeat: NOW_ISO,
    latencyMs: 10,
    autonomyLevel: "autonomous",
    lastEngineSnapshot: {
      ranAt: freshSnapshotRanAt(),
      gateReasons: [],
      perSymbol: [],
      chosenSymbol: null,
    },
    liveMoneyAcknowledgedAt: null,
    paperAccountBalance: 1000,
    paramsWiredLive: false,
    tradingPausedUntil: null,
    pauseReason: null,
    activeProfile: "active",
    lastJessicaDecision: null,
    doctrineOverlayToday: null,
    ...overrides,
  };
}

function freshMarketIntel(overrides: Partial<MarketIntelligence> = {}): MarketIntelligence {
  return {
    id: "mi1",
    symbol: "BTC-USD",
    macroBias: "neutral",
    macroConfidence: 0.5,
    marketPhase: "unknown",
    trendStructure: "unknown",
    nearestSupport: null,
    nearestResistance: null,
    keyLevelNotes: "",
    macroSummary: "",
    fundingRateSignal: "neutral",
    fundingRatePct: null,
    fearGreedScore: null,
    fearGreedLabel: null,
    sentimentSummary: "",
    environmentRating: "neutral",
    patternContext: "",
    entryQualityContext: "",
    generatedAt: new Date(NOW_MS - 30 * 60_000).toISOString(), // 30 min ago
    recentMomentum1h: null,
    recentMomentum4h: null,
    recentMomentumAt: null,
    recentMomentumNotes: "",
    candleCount1h: null,
    candleCount4h: null,
    candleCount1d: null,
    ...overrides,
  };
}

function approvedStrategy(): StrategyVersion {
  return {
    id: "strat1",
    name: "momentum-burst",
    version: "1",
    displayName: "Momentum Burst",
    friendlySummary: null,
    status: "approved",
    createdAt: NOW_ISO,
    description: "",
    params: [],
    metrics: { expectancy: 0.5, winRate: 0.6, maxDrawdown: 0.1, sharpe: 1.2, trades: 50 },
  };
}

function baseInput(overrides: Partial<TradingDecisionSnapshotInput> = {}): TradingDecisionSnapshotInput {
  return {
    system: baseSystem(),
    marketIntelligence: [freshMarketIntel()],
    strategies: [approvedStrategy()],
    alerts: [],
    nowMs: NOW_MS,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("computeTradingDecisionSnapshot", () => {
  it("canTradeNow = true when all conditions are clear (paper mode)", () => {
    const snap = computeTradingDecisionSnapshot(baseInput());
    expect(snap.canTradeNow).toBe(true);
    expect(snap.blockers).toHaveLength(0);
  });

  it("canTradeNow = false when kill switch is engaged", () => {
    const snap = computeTradingDecisionSnapshot(
      baseInput({ system: baseSystem({ killSwitchEngaged: true }) }),
    );
    expect(snap.canTradeNow).toBe(false);
    expect(snap.killSwitchEngaged).toBe(true);
    expect(snap.blockers.some((b) => b.code === "KILL_SWITCH")).toBe(true);
  });

  it("canTradeNow = false when bot is halted", () => {
    const snap = computeTradingDecisionSnapshot(
      baseInput({ system: baseSystem({ bot: "halted" }) }),
    );
    expect(snap.canTradeNow).toBe(false);
    expect(snap.botRunning).toBe(false);
    expect(snap.blockers.some((b) => b.code === "BOT_NOT_RUNNING")).toBe(true);
  });

  it("canTradeNow = false when bot is paused", () => {
    const snap = computeTradingDecisionSnapshot(
      baseInput({ system: baseSystem({ bot: "paused" }) }),
    );
    expect(snap.canTradeNow).toBe(false);
    expect(snap.botRunning).toBe(false);
  });

  it("canTradeNow = false when BALANCE_FLOOR gate is in snapshot", () => {
    const system = baseSystem({
      lastEngineSnapshot: {
        ranAt: freshSnapshotRanAt(),
        gateReasons: [{ code: "BALANCE_FLOOR", severity: "halt", message: "Floor breached." }],
        perSymbol: [],
        chosenSymbol: null,
      },
    });
    const snap = computeTradingDecisionSnapshot(baseInput({ system }));
    expect(snap.canTradeNow).toBe(false);
    expect(snap.accountFloorClear).toBe(false);
    expect(snap.blockers.some((b) => b.code === "BALANCE_FLOOR")).toBe(true);
  });

  it("canTradeNow = false when DAILY_LOSS_CAP gate is in snapshot", () => {
    const system = baseSystem({
      lastEngineSnapshot: {
        ranAt: freshSnapshotRanAt(),
        gateReasons: [{ code: "DAILY_LOSS_CAP", severity: "halt", message: "Cap hit." }],
        perSymbol: [],
        chosenSymbol: null,
      },
    });
    const snap = computeTradingDecisionSnapshot(baseInput({ system }));
    expect(snap.canTradeNow).toBe(false);
    expect(snap.dailyLossCapClear).toBe(false);
  });

  it("canTradeNow = false when no active strategy exists", () => {
    const snap = computeTradingDecisionSnapshot(baseInput({ strategies: [] }));
    expect(snap.canTradeNow).toBe(false);
    expect(snap.activeStrategyExists).toBe(false);
    expect(snap.blockers.some((b) => b.code === "NO_ACTIVE_STRATEGY")).toBe(true);
  });

  it("canTradeNow = false when doctrine overlay blocks new entries", () => {
    const system = baseSystem({
      doctrineOverlayToday: { blockNewEntries: true, mode: "lockout" },
    });
    const snap = computeTradingDecisionSnapshot(baseInput({ system }));
    expect(snap.canTradeNow).toBe(false);
    expect(snap.doctrineOverlayClear).toBe(false);
    expect(snap.blockers.some((b) => b.code === "DOCTRINE_OVERLAY_BLOCK")).toBe(true);
  });

  it("brainTrustFresh = false when market intel is older than BRAIN_TRUST_STALE_SECONDS", () => {
    const staleGeneratedAt = new Date(
      NOW_MS - (BRAIN_TRUST_STALE_SECONDS + 60) * 1000,
    ).toISOString();
    const snap = computeTradingDecisionSnapshot(
      baseInput({ marketIntelligence: [freshMarketIntel({ generatedAt: staleGeneratedAt })] }),
    );
    expect(snap.brainTrustFresh).toBe(false);
    expect(snap.blockers.some((b) => b.code === "BRAIN_TRUST_STALE")).toBe(true);
    // Paper mode: Brain Trust stale adds a blocker but does NOT hard-block canTradeNow
    // (paper mode degrades gracefully)
  });

  it("brainTrustFresh = false when no market intel data exists", () => {
    const snap = computeTradingDecisionSnapshot(baseInput({ marketIntelligence: [] }));
    expect(snap.brainTrustFresh).toBe(false);
    expect(snap.brainTrustLastAt).toBeNull();
  });

  it("paper mode does NOT require broker to be connected", () => {
    const system = baseSystem({ mode: "paper", brokerConnection: "disconnected" });
    const snap = computeTradingDecisionSnapshot(baseInput({ system }));
    expect(snap.coinbaseBrokerHealthy).toBe(false);
    // Should not be a hard block in paper mode
    expect(snap.blockers.some((b) => b.code === "BROKER_NOT_CONNECTED")).toBe(false);
    expect(snap.canTradeNow).toBe(true);
  });

  it("live mode DOES require broker to be connected", () => {
    const system = baseSystem({
      mode: "live",
      brokerConnection: "disconnected",
      liveTradingEnabled: true,
    });
    const snap = computeTradingDecisionSnapshot(baseInput({ system }));
    expect(snap.canTradeNow).toBe(false);
    expect(snap.blockers.some((b) => b.code === "BROKER_NOT_CONNECTED")).toBe(true);
  });

  it("taylorFresh = false when engine snapshot is older than TAYLOR_STALE_SECONDS", () => {
    const staleRanAt = new Date(
      NOW_MS - (TAYLOR_STALE_SECONDS + 60) * 1000,
    ).toISOString();
    const system = baseSystem({
      lastEngineSnapshot: {
        ranAt: staleRanAt,
        gateReasons: [],
        perSymbol: [],
        chosenSymbol: null,
      },
    });
    const snap = computeTradingDecisionSnapshot(baseInput({ system }));
    expect(snap.taylorFresh).toBe(false);
    expect(snap.blockers.some((b) => b.code === "TAYLOR_STALE")).toBe(true);
  });

  it("nextSafeAction populated from first blocker when blockers exist", () => {
    const snap = computeTradingDecisionSnapshot(
      baseInput({ system: baseSystem({ killSwitchEngaged: true }) }),
    );
    expect(snap.nextSafeAction).toBeTruthy();
    expect(snap.nextSafeAction).toContain("kill switch");
  });

  it("activeStrategyNames returns names of approved strategies", () => {
    const snap = computeTradingDecisionSnapshot(baseInput());
    expect(snap.activeStrategyNames).toContain("Momentum Burst");
  });

  it("candidate strategies are NOT counted as active", () => {
    const candidate: StrategyVersion = { ...approvedStrategy(), status: "candidate" };
    const snap = computeTradingDecisionSnapshot(baseInput({ strategies: [candidate] }));
    expect(snap.activeStrategyExists).toBe(false);
  });

  it("null system returns canTradeNow = false with BOT_NOT_RUNNING blocker", () => {
    const snap = computeTradingDecisionSnapshot(
      baseInput({ system: null }),
    );
    expect(snap.canTradeNow).toBe(false);
    expect(snap.mode).toBe("unknown");
  });
});
