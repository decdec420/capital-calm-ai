import { describe, it, expect } from "vitest";
import {
  buildDecisionReplayPacket,
  REPLAY_PACKET_VERSION,
  type DecisionReplayPacket,
  type DoctrineReplaySlice,
  type MarketReplaySlice,
  type ModelReplaySlice,
  type GateReplaySlice,
} from "@/lib/decision-replay";

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeMarket(overrides: Partial<MarketReplaySlice> = {}): MarketReplaySlice {
  return {
    symbol: "BTC-USD",
    regime: "trending_up",
    setupScore: 0.72,
    confidence: 0.68,
    volatility: "medium",
    brainTrustFresh: true,
    brainTrustAgeMinutes: 45,
    snapshotAgeSeconds: 120,
    ...overrides,
  };
}

function makeDoctrine(overrides: Partial<DoctrineReplaySlice> = {}): DoctrineReplaySlice {
  return {
    mode: "paper",
    dailyLossCapUsd: 2.0,
    killSwitchFloorUsd: 8.0,
    maxTradesPerDay: 5,
    maxOrderPct: 0.001,
    maxOrderAbsCap: 1.0,
    dailyLossPct: 0.02,
    floorPct: 0.8,
    profile: "sentinel",
    ...overrides,
  };
}

function makeModel(overrides: Partial<ModelReplaySlice> = {}): ModelReplaySlice {
  return {
    taylorModel: "google/gemini-3-flash-preview",
    taylorPromptVersion: "signal-engine-v2",
    riskManagerModel: "google/gemini-3-flash-preview",
    ...overrides,
  };
}

function makeGates(overrides: Partial<GateReplaySlice> = {}): GateReplaySlice {
  return {
    gates: [],
    anyRefusal: false,
    refusalCodes: [],
    ...overrides,
  };
}

function buildPacket(overrides: Partial<Parameters<typeof buildDecisionReplayPacket>[0]> = {}): DecisionReplayPacket {
  return buildDecisionReplayPacket({
    signalId: "signal-uuid-001",
    ranAt: "2026-05-10T12:00:00.000Z",
    market: makeMarket(),
    doctrine: makeDoctrine(),
    model: makeModel(),
    gates: makeGates(),
    decision: "approved",
    decisionReason: "AI proposed entry; all gates passed.",
    ...overrides,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildDecisionReplayPacket", () => {
  it("produces a packet with the correct replay version", () => {
    const packet = buildPacket();
    expect(packet.replayVersion).toBe(REPLAY_PACKET_VERSION);
    expect(packet.replayVersion).toBe("1");
  });

  it("sets packetCreatedAt to a recent ISO timestamp", () => {
    const before = new Date().toISOString();
    const packet = buildPacket();
    const after = new Date().toISOString();
    expect(packet.packetCreatedAt >= before).toBe(true);
    expect(packet.packetCreatedAt <= after).toBe(true);
  });

  it("passes signalId and ranAt through unchanged", () => {
    const packet = buildPacket({
      signalId: "my-signal-123",
      ranAt: "2026-05-10T09:00:00.000Z",
    });
    expect(packet.signalId).toBe("my-signal-123");
    expect(packet.ranAt).toBe("2026-05-10T09:00:00.000Z");
  });

  it("stores entry-regime metadata from structured market context when provided", () => {
    const packet = buildPacket({
      market: makeMarket({
        regime: "trending_up",
        entryRegime: "trending_up",
        entryRegimeSource: "signal_regime",
      }),
    });

    expect(packet.market.entryRegime).toBe("trending_up");
    expect(packet.market.entryRegimeSource).toBe("signal_regime");
  });

  it("stores unknown entry regime honestly when no structured source exists", () => {
    const packet = buildPacket({
      market: makeMarket({
        regime: "no_trade",
        entryRegime: "unknown",
        entryRegimeSource: "unknown",
      }),
    });

    expect(packet.market.entryRegime).toBe("unknown");
    expect(packet.market.entryRegimeSource).toBe("unknown");
    expect(JSON.stringify(packet.market)).not.toContain("inferred");
  });

  it("stores market context without credentials", () => {
    const packet = buildPacket({ market: makeMarket({ symbol: "ETH-USD", regime: "range", setupScore: 0.55 }) });
    expect(packet.market.symbol).toBe("ETH-USD");
    expect(packet.market.regime).toBe("range");
    expect(packet.market.setupScore).toBe(0.55);
    // No API keys, no raw credentials
    expect(JSON.stringify(packet.market)).not.toContain("apiKey");
    expect(JSON.stringify(packet.market)).not.toContain("secret");
    expect(JSON.stringify(packet.market)).not.toContain("authorization");
  });

  it("stores doctrine cap numbers only — never raw settings rows", () => {
    const packet = buildPacket({
      doctrine: makeDoctrine({
        dailyLossCapUsd: 1.5,
        killSwitchFloorUsd: 7.0,
        maxTradesPerDay: 3,
        profile: "active",
      }),
    });
    expect(packet.doctrine.dailyLossCapUsd).toBe(1.5);
    expect(packet.doctrine.killSwitchFloorUsd).toBe(7.0);
    expect(packet.doctrine.maxTradesPerDay).toBe(3);
    expect(packet.doctrine.profile).toBe("active");
  });

  it("stores model identifiers but never API keys or full prompts", () => {
    const packet = buildPacket({
      model: makeModel({
        taylorModel: "google/gemini-3-flash-preview",
        taylorPromptVersion: "signal-engine-v2",
        riskManagerModel: "google/gemini-3-flash-preview",
      }),
    });
    expect(packet.model.taylorModel).toBe("google/gemini-3-flash-preview");
    expect(packet.model.taylorPromptVersion).toBe("signal-engine-v2");
    // taylorPromptVersion should be a short tag, not a long prompt
    expect(packet.model.taylorPromptVersion.length).toBeLessThan(64);
    // No raw API key
    expect(JSON.stringify(packet.model)).not.toContain("Bearer ");
    expect(JSON.stringify(packet.model)).not.toContain("apiKey");
    expect(JSON.stringify(packet.model)).not.toContain("LOVABLE_API_KEY");
    expect(JSON.stringify(packet.model)).not.toContain("SERVICE_ROLE");
  });

  it("stores gate reasons without sensitive payload details", () => {
    const packet = buildPacket({
      gates: makeGates({
        gates: [
          { code: "ANTI_TILT_CAUTION", severity: "warn", message: "2 consecutive losses." },
        ],
        anyRefusal: false,
        refusalCodes: [],
      }),
    });
    expect(packet.gates.gates).toHaveLength(1);
    expect(packet.gates.gates[0].code).toBe("ANTI_TILT_CAUTION");
    expect(packet.gates.gates[0].severity).toBe("warn");
    expect(packet.gates.anyRefusal).toBe(false);
  });

  it("records approved decision with reason", () => {
    const packet = buildPacket({
      decision: "approved",
      decisionReason: "All gates clear. Pullback into trend.",
    });
    expect(packet.decision).toBe("approved");
    expect(packet.decisionReason).toBe("All gates clear. Pullback into trend.");
  });

  it("records blocked_by_gate decision with refusal codes", () => {
    const packet = buildPacket({
      decision: "blocked_by_gate",
      decisionReason: "Daily loss cap reached.",
      gates: makeGates({
        gates: [{ code: "DAILY_LOSS_CAP", severity: "halt", message: "Daily cap hit." }],
        anyRefusal: true,
        refusalCodes: ["DAILY_LOSS_CAP"],
      }),
    });
    expect(packet.decision).toBe("blocked_by_gate");
    expect(packet.gates.anyRefusal).toBe(true);
    expect(packet.gates.refusalCodes).toContain("DAILY_LOSS_CAP");
  });

  it("records vetoed_by_risk_manager decision", () => {
    const packet = buildPacket({
      decision: "vetoed_by_risk_manager",
      decisionReason: "Risk Manager: position too large given open BTC long.",
    });
    expect(packet.decision).toBe("vetoed_by_risk_manager");
    expect(packet.decisionReason).toContain("Risk Manager");
  });

  it("does NOT include post-trade optional fields when not provided", () => {
    const packet = buildPacket();
    expect(packet.actualOutcome).toBeUndefined();
    expect(packet.wendyGrade).toBeUndefined();
    expect(packet.outcomeRecordedAt).toBeUndefined();
  });
});

// ─── Security tests ───────────────────────────────────────────────────────────

describe("DecisionReplayPacket — sensitive data exclusion", () => {
  const SENSITIVE_PATTERNS = [
    "Bearer ",
    "SECRET",
    "SERVICE_ROLE",
    "apiKey",
    "api_key",
    "authorization",
    "COINBASE_API",
    "private_key",
    "LOVABLE_API_KEY",
  ];

  it("does not contain any sensitive credential patterns", () => {
    const packet = buildPacket();
    const serialized = JSON.stringify(packet);
    for (const pattern of SENSITIVE_PATTERNS) {
      expect(serialized).not.toContain(pattern);
    }
  });

  it("taylorPromptVersion is a short tag, never a long prompt string", () => {
    const packet = buildPacket();
    // A real prompt would be hundreds of characters; version tag is short
    expect(packet.model.taylorPromptVersion.length).toBeLessThan(128);
    // Should not look like a full prompt (contains instructions)
    expect(packet.model.taylorPromptVersion).not.toContain("You are");
    expect(packet.model.taylorPromptVersion).not.toContain("SIZING:");
    expect(packet.model.taylorPromptVersion).not.toContain("regime");
  });

  it("does not include raw candle data or full prompt payloads", () => {
    const packet = buildPacket();
    const serialized = JSON.stringify(packet);
    // Candles have a 't' (epoch) + 'o','h','l','c','v' structure — packets should be small
    // and not contain raw time-series arrays
    expect(serialized.length).toBeLessThan(4_000);
  });
});

// ─── Reconstruction tests ─────────────────────────────────────────────────────

describe("DecisionReplayPacket — decision reconstruction", () => {
  it("can reconstruct the gate decision from a blocked packet", () => {
    const packet = buildPacket({
      decision: "blocked_by_gate",
      decisionReason: "Kill switch is engaged.",
      gates: makeGates({
        gates: [{ code: "KILL_SWITCH", severity: "halt", message: "Kill switch is engaged." }],
        anyRefusal: true,
        refusalCodes: ["KILL_SWITCH"],
      }),
    });

    // Reconstructor can answer: was this blocked? Why?
    expect(packet.decision).toBe("blocked_by_gate");
    expect(packet.gates.anyRefusal).toBe(true);
    expect(packet.gates.refusalCodes).toContain("KILL_SWITCH");
    const killSwitchGate = packet.gates.gates.find((g) => g.code === "KILL_SWITCH");
    expect(killSwitchGate).toBeDefined();
    expect(killSwitchGate!.severity).toBe("halt");
  });

  it("can reconstruct doctrine limits that were in effect at decision time", () => {
    const packet = buildPacket({
      doctrine: makeDoctrine({
        mode: "live",
        dailyLossCapUsd: 5.0,
        killSwitchFloorUsd: 40.0,
        maxTradesPerDay: 10,
        profile: "aggressive",
      }),
    });

    // Future session can re-run the gate math without re-fetching user settings
    expect(packet.doctrine.mode).toBe("live");
    expect(packet.doctrine.dailyLossCapUsd).toBe(5.0);
    expect(packet.doctrine.killSwitchFloorUsd).toBe(40.0);
    expect(packet.doctrine.maxTradesPerDay).toBe(10);
    expect(packet.doctrine.profile).toBe("aggressive");
  });

  it("can reconstruct market context at decision time", () => {
    const packet = buildPacket({
      market: makeMarket({
        symbol: "SOL-USD",
        regime: "trending_up",
        setupScore: 0.81,
        confidence: 0.75,
        volatility: "high",
        brainTrustFresh: false,
        brainTrustAgeMinutes: 150,
        snapshotAgeSeconds: 300,
      }),
    });

    expect(packet.market.symbol).toBe("SOL-USD");
    expect(packet.market.regime).toBe("trending_up");
    expect(packet.market.setupScore).toBe(0.81);
    expect(packet.market.confidence).toBe(0.75);
    expect(packet.market.volatility).toBe("high");
    expect(packet.market.brainTrustFresh).toBe(false);
    expect(packet.market.brainTrustAgeMinutes).toBe(150);
    expect(packet.market.snapshotAgeSeconds).toBe(300);
  });

  it("can reconstruct which AI model and prompt version was used", () => {
    const packet = buildPacket({
      model: makeModel({
        taylorModel: "google/gemini-3-flash-preview",
        taylorPromptVersion: "signal-engine-v3",
        riskManagerModel: "anthropic/claude-sonnet-4-6",
        inputPacketHash: "abc123def456",
      }),
    });

    expect(packet.model.taylorModel).toBe("google/gemini-3-flash-preview");
    expect(packet.model.taylorPromptVersion).toBe("signal-engine-v3");
    expect(packet.model.riskManagerModel).toBe("anthropic/claude-sonnet-4-6");
    expect(packet.model.inputPacketHash).toBe("abc123def456");
  });

  it("round-trips through JSON serialisation without data loss", () => {
    const packet = buildPacket({
      signalId: "signal-roundtrip-test",
      decision: "blocked_by_gate",
      gates: makeGates({
        gates: [
          { code: "BALANCE_FLOOR", severity: "halt", message: "Equity below kill-switch floor." },
          { code: "ANTI_TILT_CAUTION", severity: "warn", message: "2 losses in a row." },
        ],
        anyRefusal: true,
        refusalCodes: ["BALANCE_FLOOR"],
      }),
    });

    const serialized = JSON.stringify(packet);
    const restored = JSON.parse(serialized) as DecisionReplayPacket;

    expect(restored.replayVersion).toBe(packet.replayVersion);
    expect(restored.signalId).toBe(packet.signalId);
    expect(restored.decision).toBe(packet.decision);
    expect(restored.gates.gates).toHaveLength(2);
    expect(restored.gates.anyRefusal).toBe(true);
    expect(restored.doctrine.dailyLossCapUsd).toBe(packet.doctrine.dailyLossCapUsd);
    expect(restored.market.setupScore).toBe(packet.market.setupScore);
    expect(restored.model.taylorModel).toBe(packet.model.taylorModel);
  });
});
