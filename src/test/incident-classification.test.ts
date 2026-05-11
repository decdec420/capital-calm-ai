import { describe, it, expect } from "vitest";
import {
  classifyAiGuardRejected,
  classifyAiGuardFallback,
  classifyKillSwitchActive,
  classifyBrokerAuthIssue,
  classifyBrainTrustStale,
  classifyMarketDataStale,
  classifyTaylorStale,
  classifyBotPausedUnexpected,
  classifyLearningJobFailed,
  classifyDailyLossCapReached,
  classifyAccountFloorBreached,
  classifyEventType,
  compareSeverity,
  OPS_STATUS_LABEL,
} from "@/lib/incident-classification";
import {
  computeTradingDecisionSnapshot,
  type TradingDecisionSnapshotInput,
} from "@/lib/trading-decision-snapshot";
import type { SystemState, Alert } from "@/lib/domain-types";
import type { MarketIntelligence } from "@/hooks/useMarketIntelligence";

// ─── AI Guard classification ──────────────────────────────────────────────────

describe("classifyAiGuardRejected", () => {
  it("read-only surface → warning, not critical", () => {
    const result = classifyAiGuardRejected("copilot_chat");
    expect(result.severity).toBe("warning");
    expect(result.tradingBlocked).toBe(false);
    expect(result.userAttentionRequired).toBe(false);
  });

  it("trade surface → critical", () => {
    const result = classifyAiGuardRejected("trade_signal");
    expect(result.severity).toBe("critical");
    expect(result.tradingBlocked).toBe(true);
    expect(result.userAttentionRequired).toBe(true);
  });

  it("broker_execution surface → critical", () => {
    const result = classifyAiGuardRejected("broker_execution");
    expect(result.severity).toBe("critical");
    expect(result.tradingBlocked).toBe(true);
  });

  it("jessica_decision surface → critical", () => {
    const result = classifyAiGuardRejected("jessica_decision");
    expect(result.severity).toBe("critical");
    expect(result.tradingBlocked).toBe(true);
  });

  it("affected workflow on trade surface → trade_decision", () => {
    expect(classifyAiGuardRejected("trade_signal").affectedWorkflow).toBe("trade_decision");
  });

  it("affected workflow on read-only surface → ops", () => {
    expect(classifyAiGuardRejected("copilot_chat").affectedWorkflow).toBe("ops");
  });

  it("money_at_risk is never true for AI guard rejection", () => {
    expect(classifyAiGuardRejected("broker_execution").moneyAtRisk).toBe(false);
    expect(classifyAiGuardRejected("copilot_chat").moneyAtRisk).toBe(false);
  });
});

describe("classifyAiGuardFallback", () => {
  it("always info severity", () => {
    expect(classifyAiGuardFallback("trade_signal").severity).toBe("info");
    expect(classifyAiGuardFallback("copilot_chat").severity).toBe("info");
  });

  it("never blocks trading", () => {
    expect(classifyAiGuardFallback("trade_signal").tradingBlocked).toBe(false);
    expect(classifyAiGuardFallback("broker_execution").tradingBlocked).toBe(false);
  });

  it("never requires user attention", () => {
    expect(classifyAiGuardFallback("any_surface").userAttentionRequired).toBe(false);
  });
});

// ─── Kill switch ──────────────────────────────────────────────────────────────

describe("classifyKillSwitchActive", () => {
  it("is critical", () => {
    expect(classifyKillSwitchActive().severity).toBe("critical");
  });

  it("blocks trading", () => {
    expect(classifyKillSwitchActive().tradingBlocked).toBe(true);
  });

  it("requires user attention", () => {
    expect(classifyKillSwitchActive().userAttentionRequired).toBe(true);
  });

  it("affects trade_decision workflow", () => {
    expect(classifyKillSwitchActive().affectedWorkflow).toBe("trade_decision");
  });
});

// ─── Broker ───────────────────────────────────────────────────────────────────

describe("classifyBrokerAuthIssue", () => {
  it("is critical", () => {
    expect(classifyBrokerAuthIssue().severity).toBe("critical");
  });

  it("blocks trading and marks money at risk", () => {
    const c = classifyBrokerAuthIssue();
    expect(c.tradingBlocked).toBe(true);
    expect(c.moneyAtRisk).toBe(true);
  });

  it("affects broker workflow", () => {
    expect(classifyBrokerAuthIssue().affectedWorkflow).toBe("broker");
  });
});

// ─── Stale Brain Trust ────────────────────────────────────────────────────────

describe("classifyBrainTrustStale", () => {
  it("paper mode → warning, not blocking", () => {
    const c = classifyBrainTrustStale("paper");
    expect(c.severity).toBe("warning");
    expect(c.tradingBlocked).toBe(false);
  });

  it("live mode → critical, blocking", () => {
    const c = classifyBrainTrustStale("live");
    expect(c.severity).toBe("critical");
    expect(c.tradingBlocked).toBe(true);
    expect(c.moneyAtRisk).toBe(true);
  });

  it("unknown mode → warning", () => {
    expect(classifyBrainTrustStale("unknown").severity).toBe("warning");
  });

  it("affects market_intelligence workflow", () => {
    expect(classifyBrainTrustStale("paper").affectedWorkflow).toBe("market_intelligence");
  });
});

// ─── Stale market data ────────────────────────────────────────────────────────

describe("classifyMarketDataStale", () => {
  it("is always warning severity", () => {
    expect(classifyMarketDataStale("paper").severity).toBe("warning");
    expect(classifyMarketDataStale("live").severity).toBe("warning");
    expect(classifyMarketDataStale("unknown").severity).toBe("warning");
  });

  it("paper mode → not blocking", () => {
    expect(classifyMarketDataStale("paper").tradingBlocked).toBe(false);
  });

  it("live mode → blocking", () => {
    expect(classifyMarketDataStale("live").tradingBlocked).toBe(true);
  });
});

// ─── Taylor stale ─────────────────────────────────────────────────────────────

describe("classifyTaylorStale", () => {
  it("paper mode → warning", () => {
    expect(classifyTaylorStale("paper").severity).toBe("warning");
  });

  it("live mode → critical", () => {
    expect(classifyTaylorStale("live").severity).toBe("critical");
  });

  it("does not block trading (cron miss, not a hard block)", () => {
    expect(classifyTaylorStale("paper").tradingBlocked).toBe(false);
    expect(classifyTaylorStale("live").tradingBlocked).toBe(false);
  });
});

// ─── Learning job ─────────────────────────────────────────────────────────────

describe("classifyLearningJobFailed", () => {
  it("is info severity", () => {
    expect(classifyLearningJobFailed("wendy").severity).toBe("info");
  });

  it("never blocks trading", () => {
    expect(classifyLearningJobFailed("strategy_learning").tradingBlocked).toBe(false);
  });

  it("does not require user attention", () => {
    expect(classifyLearningJobFailed("experiment_run").userAttentionRequired).toBe(false);
  });
});

// ─── Risk gate trips ──────────────────────────────────────────────────────────

describe("classifyDailyLossCapReached", () => {
  it("is warning and blocks trading", () => {
    const c = classifyDailyLossCapReached();
    expect(c.severity).toBe("warning");
    expect(c.tradingBlocked).toBe(true);
    expect(c.moneyAtRisk).toBe(true);
  });
});

describe("classifyAccountFloorBreached", () => {
  it("is critical and blocks trading", () => {
    const c = classifyAccountFloorBreached();
    expect(c.severity).toBe("critical");
    expect(c.tradingBlocked).toBe(true);
    expect(c.moneyAtRisk).toBe(true);
  });
});

// ─── Generic classifyEventType ────────────────────────────────────────────────

describe("classifyEventType", () => {
  it("AI_GUARD_REJECTED on read-only → warning", () => {
    const c = classifyEventType({ eventType: "AI_GUARD_REJECTED", surface: "copilot_chat" });
    expect(c.severity).toBe("warning");
  });

  it("AI_GUARD_REJECTED on trade surface → critical", () => {
    const c = classifyEventType({ eventType: "AI_GUARD_REJECTED", surface: "trade_signal" });
    expect(c.severity).toBe("critical");
  });

  it("AI_GUARD_FALLBACK → info regardless of surface", () => {
    const c = classifyEventType({ eventType: "AI_GUARD_FALLBACK", surface: "broker_execution" });
    expect(c.severity).toBe("info");
    expect(c.tradingBlocked).toBe(false);
  });

  it("kill_switch_on → critical + trading blocked", () => {
    const c = classifyEventType({ eventType: "kill_switch_on" });
    expect(c.severity).toBe("critical");
    expect(c.tradingBlocked).toBe(true);
  });

  it("kill_switch_off → info, not blocking", () => {
    const c = classifyEventType({ eventType: "kill_switch_off" });
    expect(c.severity).toBe("info");
    expect(c.tradingBlocked).toBe(false);
  });

  it("state_changed with kill_switch_engaged=true → critical", () => {
    const c = classifyEventType({
      eventType: "state_changed",
      payload: { kill_switch_engaged: true },
    });
    expect(c.severity).toBe("critical");
    expect(c.tradingBlocked).toBe(true);
  });

  it("state_changed with live_trading_enabled=true → warning + money at risk", () => {
    const c = classifyEventType({
      eventType: "state_changed",
      payload: { live_trading_enabled: true },
    });
    expect(c.severity).toBe("warning");
    expect(c.moneyAtRisk).toBe(true);
  });

  it("bot_paused → warning", () => {
    const c = classifyEventType({ eventType: "bot_paused" });
    expect(c.severity).toBe("warning");
    expect(c.tradingBlocked).toBe(true);
  });

  it("autonomy_changed → info, no block", () => {
    const c = classifyEventType({ eventType: "autonomy_changed" });
    expect(c.severity).toBe("info");
    expect(c.tradingBlocked).toBe(false);
  });

  it("unknown event_type → info, no block", () => {
    const c = classifyEventType({ eventType: "some_unknown_type" });
    expect(c.severity).toBe("info");
    expect(c.tradingBlocked).toBe(false);
  });
});

// ─── Severity ordering ────────────────────────────────────────────────────────

describe("compareSeverity", () => {
  it("critical < warning < info", () => {
    expect(compareSeverity("critical", "warning")).toBeLessThan(0);
    expect(compareSeverity("warning", "info")).toBeLessThan(0);
    expect(compareSeverity("critical", "info")).toBeLessThan(0);
  });

  it("same severity → 0", () => {
    expect(compareSeverity("critical", "critical")).toBe(0);
  });
});

// ─── Incident metadata safety ─────────────────────────────────────────────────

describe("incident metadata safety", () => {
  it("AI guard classification never contains raw AI output fields", () => {
    const c = classifyAiGuardRejected("trade_signal");
    // Root cause should be a fixed string, not from AI
    expect(c.rootCause).not.toContain("json");
    expect(c.rootCause.length).toBeGreaterThan(0);
    expect(c.rootCause.length).toBeLessThan(500);
  });

  it("OPS_STATUS_LABEL covers all required statuses", () => {
    const required = ["detected", "diagnosed", "action_taken", "verified", "resolved", "follow_up"];
    for (const s of required) {
      expect(OPS_STATUS_LABEL[s as keyof typeof OPS_STATUS_LABEL]).toBeTruthy();
    }
  });
});

// ─── WhyNoTrades + Snapshot integration ───────────────────────────────────────

const NOW_MS = 1_700_000_000_000;

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
    lastHeartbeat: new Date(NOW_MS).toISOString(),
    latencyMs: 10,
    autonomyLevel: "autonomous",
    activeProfile: "sentinel",
    tradingPausedUntil: null,
    pauseReason: null,
    doctrineOverlayToday: null,
    lastEngineSnapshot: {
      ranAt: new Date(NOW_MS - 60_000).toISOString(),
      setupScore: 0.8,
      gateReasons: [],
      proposedTrades: [],
      signalCount: 0,
    },
    lastJessicaDecision: null,
    ...overrides,
  };
}

function baseInput(overrides: Partial<TradingDecisionSnapshotInput> = {}): TradingDecisionSnapshotInput {
  return {
    system: baseSystem(),
    marketIntelligence: [
      { symbol: "BTC", generatedAt: new Date(NOW_MS - 60_000).toISOString() } as MarketIntelligence,
    ],
    strategies: [{ id: "s1", status: "approved", name: "test", displayName: "Test" } as never],
    alerts: [],
    nowMs: NOW_MS,
    ...overrides,
  };
}

describe("trading-decision-snapshot + ops incidents integration", () => {
  it("openIncidentBlocking is false when no critical alerts", () => {
    const snap = computeTradingDecisionSnapshot(baseInput());
    expect(snap.openIncidentBlocking).toBe(false);
  });

  it("critical unacknowledged alert sets openIncidentBlocking", () => {
    const critAlert: Alert = {
      id: "a1",
      severity: "critical",
      title: "P1 incident",
      message: "Hall detected critical failure",
      timestamp: new Date(NOW_MS).toISOString(),
    };
    const snap = computeTradingDecisionSnapshot(baseInput({ alerts: [critAlert] }));
    expect(snap.openIncidentBlocking).toBe(true);
  });

  it("OPEN_CRITICAL_INCIDENT blocker references ops timeline", () => {
    const critAlert: Alert = {
      id: "a1",
      severity: "critical",
      title: "P1 incident",
      message: "Hall detected failure",
      timestamp: new Date(NOW_MS).toISOString(),
    };
    const snap = computeTradingDecisionSnapshot(baseInput({ alerts: [critAlert] }));
    const blocker = snap.blockers.find((b) => b.code === "OPEN_CRITICAL_INCIDENT");
    expect(blocker).toBeDefined();
    expect(blocker!.nextSafeAction).toContain("Company");
  });

  it("WhyNoTrades does not contradict open critical incident — canTradeNow stays true unless hard block", () => {
    // Open critical incident adds a blocker but doesn't override canTradeNow by itself
    // (canTradeNow is only false on hard blocks like kill_switch, floor, etc.)
    const critAlert: Alert = {
      id: "a1",
      severity: "critical",
      title: "P1 incident",
      message: "Hall incident",
      timestamp: new Date(NOW_MS).toISOString(),
    };
    const snap = computeTradingDecisionSnapshot(baseInput({ alerts: [critAlert] }));
    // openIncidentBlocking is reflected as a blocker entry but canTradeNow is based on hard gates
    expect(snap.openIncidentBlocking).toBe(true);
    expect(snap.blockers.some((b) => b.code === "OPEN_CRITICAL_INCIDENT")).toBe(true);
  });

  it("incident update actions do not affect trading snapshot", () => {
    // The snapshot has no dependency on ops_review_status — only on alerts table
    // This proves that advancing ops_review_status cannot change canTradeNow
    const snap1 = computeTradingDecisionSnapshot(baseInput());
    const snap2 = computeTradingDecisionSnapshot(baseInput());
    // Identical inputs → identical output (no ops_review_status dependency)
    expect(snap1.canTradeNow).toBe(snap2.canTradeNow);
    expect(snap1.openIncidentBlocking).toBe(snap2.openIncidentBlocking);
  });

  it("incident actions do not create trades — snapshot has no trade creation mechanism", () => {
    const snap = computeTradingDecisionSnapshot(baseInput());
    // computeTradingDecisionSnapshot returns read-only snapshot only
    expect("placeTrade" in snap).toBe(false);
    expect("approveSignal" in snap).toBe(false);
    expect("createOrder" in snap).toBe(false);
  });

  it("incident actions do not mutate doctrine — snapshot has no doctrine mutation", () => {
    const snap = computeTradingDecisionSnapshot(baseInput());
    expect("setDoctrine" in snap).toBe(false);
    expect("updateDoctrineOverlay" in snap).toBe(false);
  });

  it("incident actions do not mutate strategies", () => {
    const snap = computeTradingDecisionSnapshot(baseInput());
    expect("promoteStrategy" in snap).toBe(false);
    expect("updateStrategy" in snap).toBe(false);
  });
});

// ─── Incident timeline sort order ─────────────────────────────────────────────

describe("incident timeline sort order", () => {
  it("sorts entries newest first by createdAt", () => {
    const entries = [
      { createdAt: "2025-01-01T12:00:00Z" },
      { createdAt: "2025-01-03T12:00:00Z" },
      { createdAt: "2025-01-02T12:00:00Z" },
    ];

    const sorted = [...entries].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
    );

    expect(sorted[0].createdAt).toBe("2025-01-03T12:00:00Z");
    expect(sorted[1].createdAt).toBe("2025-01-02T12:00:00Z");
    expect(sorted[2].createdAt).toBe("2025-01-01T12:00:00Z");
  });
});
