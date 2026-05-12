import { describe, it, expect } from "vitest";
import {
  computeLiveReadiness,
  type LiveReadinessInput,
} from "@/lib/live-readiness";
import {
  computeTradingDecisionSnapshot,
  type TradingDecisionSnapshotInput,
} from "@/lib/trading-decision-snapshot";
import type { SystemState, StrategyVersion, Alert } from "@/lib/domain-types";
import type { MarketIntelligence } from "@/hooks/useMarketIntelligence";
import type { BrokerHealth } from "@/hooks/useBrokerHealth";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW_MS = 1_700_000_000_000;

function freshSystem(overrides: Partial<SystemState> = {}): SystemState {
  return {
    id: "s1",
    mode: "paper",
    bot: "running",
    brokerConnection: "connected",
    dataFeed: "connected",
    killSwitchEngaged: false,
    liveTradingEnabled: false,
    uptimeHours: 1,
    lastHeartbeat: new Date(NOW_MS).toISOString(),
    latencyMs: 10,
    autonomyLevel: "autonomous",
    lastEngineSnapshot: {
      ranAt: new Date(NOW_MS - 60_000).toISOString(),
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

function freshBrokerHealth(overrides: Partial<BrokerHealth> = {}): BrokerHealth {
  return {
    status: "healthy",
    keyName: "organizations/test/apiKeys/paper-key",
    lastSuccessAt: new Date(NOW_MS - 60_000).toISOString(),
    lastFailureAt: null,
    lastError: null,
    updatedAt: new Date(NOW_MS - 60_000).toISOString(),
    ...overrides,
  };
}

function freshIntel(): MarketIntelligence {
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
    generatedAt: new Date(NOW_MS - 30 * 60_000).toISOString(),
    recentMomentum1h: null,
    recentMomentum4h: null,
    recentMomentumAt: null,
    recentMomentumNotes: "",
    candleCount1h: null,
    candleCount4h: null,
    candleCount1d: null,
  };
}

function approvedStrategy(): StrategyVersion {
  return {
    id: "strat1",
    name: "momentum",
    version: "1",
    displayName: "Momentum",
    friendlySummary: null,
    status: "approved",
    createdAt: new Date(NOW_MS).toISOString(),
    description: "",
    params: [],
    metrics: { expectancy: 0.5, winRate: 0.6, maxDrawdown: 0.1, sharpe: 1.2, trades: 50 },
  };
}

function baseSnapshot(
  systemOverrides: Partial<SystemState> = {},
  extras: Partial<TradingDecisionSnapshotInput> = {},
) {
  return computeTradingDecisionSnapshot({
    system: freshSystem(systemOverrides),
    marketIntelligence: [freshIntel()],
    strategies: [approvedStrategy()],
    alerts: [],
    ...extras,
    nowMs: NOW_MS,
  });
}

function baseInput(
  systemOverrides: Partial<SystemState> = {},
  brokerOverrides: Partial<BrokerHealth> = {},
  snapshotExtras: Partial<TradingDecisionSnapshotInput> = {},
): LiveReadinessInput {
  return {
    snapshot: baseSnapshot(systemOverrides, snapshotExtras),
    brokerHealth: freshBrokerHealth(brokerOverrides),
    nowMs: NOW_MS,
  };
}

// ─── Transfer permission ───────────────────────────────────────────────────────

describe("Transfer permission safety", () => {
  it("is critical fail when TRANSFER_PERMISSION_DETECTED in last_error", () => {
    const report = computeLiveReadiness(baseInput({}, {
      status: "auth_failed",
      lastError: "TRANSFER_PERMISSION_DETECTED",
    }));
    const check = report.checks.find((c) => c.id === "TRANSFER_PERMISSION_ABSENT");
    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("critical");
    expect(report.brokerPermissionSummary.transferPermission).toBe("detected");
  });

  it("overallStatus is not_ready when Transfer permission is detected", () => {
    const report = computeLiveReadiness(baseInput({}, {
      status: "auth_failed",
      lastError: "TRANSFER_PERMISSION_DETECTED",
    }));
    expect(report.overallStatus).toBe("not_ready");
  });

  it("Transfer permission absent (healthy broker) is a pass", () => {
    const report = computeLiveReadiness(baseInput());
    const check = report.checks.find((c) => c.id === "TRANSFER_PERMISSION_ABSENT");
    expect(check?.status).toBe("pass");
    expect(report.brokerPermissionSummary.transferPermission).toBe("absent");
  });

  it("Transfer absent check is still critical severity (to flag if ever detected)", () => {
    const check = computeLiveReadiness(baseInput()).checks.find(
      (c) => c.id === "TRANSFER_PERMISSION_ABSENT",
    );
    expect(check?.severity).toBe("critical");
  });
});

// ─── Paper mode does not require Trade permission ─────────────────────────────

describe("Paper mode and Trade permission", () => {
  it("paper mode is ready even when Trade permission is unknown", () => {
    // broker_health doesn't expose Trade permission — should remain unknown
    const report = computeLiveReadiness(baseInput());
    expect(report.brokerPermissionSummary.tradePermission).toBe("unknown");
    expect(report.paperReady).toBe(true);
  });

  it("paper mode ready even when broker status is not_connected (broker not required for paper)", () => {
    // Kill switch disarmed, no critical incidents, strategy exists → paper should be viable
    // Broker not connected doesn't block paper mode
    const report = computeLiveReadiness(
      baseInput({}, { status: "not_connected", keyName: null, lastSuccessAt: null }),
    );
    // Paper mode readiness: only critical-scope "both"/"paper" checks block it
    // BROKER_AUTH_HEALTHY is scoped to "live" — so paper should still be ready
    expect(report.paperReady).toBe(true);
  });

  it("Trade permission check explains paper mode does not require Trade permission", () => {
    const report = computeLiveReadiness(baseInput());
    const check = report.checks.find((c) => c.id === "TRADE_PERMISSION_SAFE");
    expect(check?.explanation).toMatch(/paper mode/i);
    expect(check?.explanation).toMatch(/does not require/i);
  });
});

// ─── Missing broker permission data blocks live, not paper ────────────────────

describe("Missing broker permission data", () => {
  it("not_connected broker fails live readiness (BROKER_AUTH_HEALTHY is live-scoped)", () => {
    const report = computeLiveReadiness(
      baseInput({}, { status: "not_connected", keyName: null }),
    );
    const check = report.checks.find((c) => c.id === "BROKER_AUTH_HEALTHY");
    expect(check?.status).toBe("fail");
    expect(check?.requiredFor).toBe("live");
    expect(report.liveReady).toBe(false);
  });

  it("not_connected broker does NOT fail paper readiness", () => {
    const report = computeLiveReadiness(
      baseInput({}, { status: "not_connected", keyName: null }),
    );
    expect(report.paperReady).toBe(true);
  });
});

// ─── Missing account state blocks live readiness ──────────────────────────────

describe("Account state freshness", () => {
  it("missing account state is unknown — blocks live not paper", () => {
    // portfolioRisk = null means no account state input provided
    const snap = computeTradingDecisionSnapshot({
      system: freshSystem(),
      marketIntelligence: [freshIntel()],
      strategies: [approvedStrategy()],
      alerts: [],
      // portfolioRiskInput omitted → portfolioRisk = null
      nowMs: NOW_MS,
    });
    const report = computeLiveReadiness({
      snapshot: snap,
      brokerHealth: freshBrokerHealth(),
      nowMs: NOW_MS,
    });
    const check = report.checks.find((c) => c.id === "ACCOUNT_STATE_FRESH");
    expect(check?.status).toBe("unknown");
    expect(check?.requiredFor).toBe("live");
  });
});

// ─── Portfolio risk unknown blocks live readiness ─────────────────────────────

describe("Portfolio risk", () => {
  it("unknown portfolio risk is unknown severity for live check", () => {
    const snap = computeTradingDecisionSnapshot({
      system: freshSystem(),
      marketIntelligence: [freshIntel()],
      strategies: [approvedStrategy()],
      alerts: [],
      nowMs: NOW_MS,
    });
    const report = computeLiveReadiness({
      snapshot: snap,
      brokerHealth: freshBrokerHealth(),
      nowMs: NOW_MS,
    });
    const check = report.checks.find((c) => c.id === "PORTFOLIO_RISK_KNOWN");
    expect(check?.status).toBe("unknown");
    expect(check?.requiredFor).toBe("live");
  });
});

// ─── Kill switch ──────────────────────────────────────────────────────────────

describe("Kill switch", () => {
  it("kill switch engaged is a critical fail for both paper and live", () => {
    const report = computeLiveReadiness(baseInput({ killSwitchEngaged: true }));
    const check = report.checks.find((c) => c.id === "KILL_SWITCH_CLEAR");
    expect(check?.status).toBe("fail");
    expect(check?.severity).toBe("critical");
    expect(check?.requiredFor).toBe("both");
    expect(report.paperReady).toBe(false);
    expect(report.liveReady).toBe(false);
    expect(report.overallStatus).toBe("not_ready");
  });

  it("kill switch disarmed passes", () => {
    const report = computeLiveReadiness(baseInput({ killSwitchEngaged: false }));
    const check = report.checks.find((c) => c.id === "KILL_SWITCH_CLEAR");
    expect(check?.status).toBe("pass");
  });
});

// ─── Open critical incident ───────────────────────────────────────────────────

describe("Critical incidents", () => {
  it("open critical incident is a fail for both modes", () => {
    const alert: Alert = {
      id: "a1",
      severity: "critical",
      category: "system",
      title: "System failure",
      message: "Engine down",
      timestamp: new Date(NOW_MS).toISOString(),
      triggeredAt: new Date(NOW_MS).toISOString(),
      acknowledgedAt: null,
      resolvedAt: null,
      source: "hall",
      details: null,
      agentId: null,
    };
    const report = computeLiveReadiness(
      baseInput({}, {}, { alerts: [alert] }),
    );
    const check = report.checks.find((c) => c.id === "NO_CRITICAL_INCIDENTS");
    expect(check?.status).toBe("fail");
    expect(check?.requiredFor).toBe("both");
    expect(report.paperReady).toBe(false);
  });

  it("no incidents passes", () => {
    const report = computeLiveReadiness(baseInput());
    const check = report.checks.find((c) => c.id === "NO_CRITICAL_INCIDENTS");
    expect(check?.status).toBe("pass");
  });
});

// ─── Live money not acknowledged ──────────────────────────────────────────────

describe("Live mode / acknowledgement", () => {
  it("live mode off → LIVE_MODE_DISABLED passes (expected state)", () => {
    const report = computeLiveReadiness(baseInput({ mode: "paper" }));
    const check = report.checks.find((c) => c.id === "LIVE_MODE_DISABLED");
    expect(check?.status).toBe("pass");
  });

  it("live mode on → LIVE_MODE_DISABLED warns", () => {
    const report = computeLiveReadiness(baseInput({ mode: "live" }));
    const check = report.checks.find((c) => c.id === "LIVE_MODE_DISABLED");
    expect(check?.status).toBe("warn");
  });

  it("live mode disabled does not hurt paper readiness", () => {
    const report = computeLiveReadiness(baseInput({ mode: "paper" }));
    // Live mode disabled = pass, so paper readiness is not blocked by it
    expect(report.paperReady).toBe(true);
  });
});

// ─── Read-only / View permission ──────────────────────────────────────────────

describe("View permission", () => {
  it("healthy broker → View permission passes", () => {
    const report = computeLiveReadiness(baseInput());
    expect(report.brokerPermissionSummary.viewPermission).toBe("pass");
    const check = report.checks.find((c) => c.id === "VIEW_PERMISSION_PRESENT");
    expect(check?.status).toBe("pass");
  });

  it("auth_failed broker → View permission fails", () => {
    const report = computeLiveReadiness(
      baseInput({}, { status: "auth_failed", lastError: "COINBASE_AUTH_FAILED" }),
    );
    expect(report.brokerPermissionSummary.viewPermission).toBe("fail");
  });
});

// ─── Secrets excluded ─────────────────────────────────────────────────────────

describe("Secrets exclusion", () => {
  it("report never contains the API key value", () => {
    const report = computeLiveReadiness(
      baseInput({}, { keyName: "organizations/test/apiKeys/my-key" }),
    );
    const serialized = JSON.stringify(report);
    // Key name is ok; key value / private PEM is not
    expect(serialized).toContain("my-key");
    // Verify we never expose anything that looks like a private key
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("BEGIN EC PRIVATE KEY");
  });

  it("keyName in permissionSummary is for identification only, not execution", () => {
    const report = computeLiveReadiness(
      baseInput({}, { keyName: "organizations/test/apiKeys/view-only" }),
    );
    expect(report.brokerPermissionSummary.keyName).toBe("organizations/test/apiKeys/view-only");
    // No raw credential / secret fields in the summary
    const keys = Object.keys(report.brokerPermissionSummary);
    expect(keys).not.toContain("apiKeyPrivatePem");
    expect(keys).not.toContain("secret");
    expect(keys).not.toContain("password");
  });
});

// ─── No mutations ──────────────────────────────────────────────────────────────

describe("No mutations", () => {
  it("readiness check does not mutate the input snapshot", () => {
    const snap = baseSnapshot();
    const beforeBlockers = snap.blockers.length;
    computeLiveReadiness({ snapshot: snap, brokerHealth: freshBrokerHealth(), nowMs: NOW_MS });
    expect(snap.blockers.length).toBe(beforeBlockers);
  });

  it("readiness check does not add strategies", () => {
    const strategies = [approvedStrategy()];
    const snap = computeTradingDecisionSnapshot({
      system: freshSystem(),
      marketIntelligence: [freshIntel()],
      strategies,
      alerts: [],
      nowMs: NOW_MS,
    });
    const beforeCount = strategies.length;
    computeLiveReadiness({ snapshot: snap, brokerHealth: freshBrokerHealth(), nowMs: NOW_MS });
    expect(strategies.length).toBe(beforeCount);
  });

  it("computeLiveReadiness returns a new object — does not modify brokerHealth input", () => {
    const broker = freshBrokerHealth();
    const originalStatus = broker.status;
    computeLiveReadiness({ snapshot: baseSnapshot(), brokerHealth: broker, nowMs: NOW_MS });
    expect(broker.status).toBe(originalStatus);
  });
});

// ─── UI copy verifiable via model ────────────────────────────────────────────

describe("Safety copy in model", () => {
  it("Transfer fail safeAction says to revoke API key", () => {
    const report = computeLiveReadiness(baseInput({}, {
      status: "auth_failed",
      lastError: "TRANSFER_PERMISSION_DETECTED",
    }));
    const check = report.checks.find((c) => c.id === "TRANSFER_PERMISSION_ABSENT");
    expect(check?.safeAction).toMatch(/revoke/i);
  });

  it("paper-only Trade permission check mentions paper mode does not require it", () => {
    const check = computeLiveReadiness(baseInput()).checks.find(
      (c) => c.id === "TRADE_PERMISSION_SAFE",
    );
    expect(check?.safeAction).toMatch(/paper mode/i);
    expect(check?.safeAction).toMatch(/never requires/i);
  });

  it("overall nextSafeAction is populated", () => {
    const report = computeLiveReadiness(baseInput());
    expect(report.nextSafeAction.length).toBeGreaterThan(5);
  });
});

// ─── Status matrix ────────────────────────────────────────────────────────────

describe("Overall status derivation", () => {
  it("healthy paper setup → paper_only_ready or better", () => {
    const report = computeLiveReadiness(baseInput());
    expect(["paper_only_ready", "live_ready_blocked", "live_ready_possible"]).toContain(
      report.overallStatus,
    );
    expect(report.paperReady).toBe(true);
  });

  it("kill switch engaged → not_ready", () => {
    const report = computeLiveReadiness(baseInput({ killSwitchEngaged: true }));
    expect(report.overallStatus).toBe("not_ready");
  });

  it("transfer permission detected → not_ready regardless of other state", () => {
    const report = computeLiveReadiness(
      baseInput({}, { status: "auth_failed", lastError: "TRANSFER_PERMISSION_DETECTED" }),
    );
    expect(report.overallStatus).toBe("not_ready");
  });

  it("snapshot null → not_ready (no data = no readiness)", () => {
    const report = computeLiveReadiness({
      snapshot: null,
      brokerHealth: freshBrokerHealth(),
      nowMs: NOW_MS,
    });
    expect(report.paperReady).toBe(false);
    expect(report.overallStatus).toBe("not_ready");
  });
});
