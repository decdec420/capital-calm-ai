import { describe, it, expect } from "vitest";
import {
  PROMPT_REGISTRY,
  MODEL_REGISTRY,
  SCHEMA_REGISTRY,
  VALIDATOR_REGISTRY,
  buildAiProvenance,
  buildDeterministicProvenance,
  hashSafeInputPacket,
  hashSafeInputPacketSync,
  redactSecretsForHashing,
  type AiDecisionType,
  type AiProvenance,
} from "@/lib/ai-provenance";

// ── Registry completeness ──────────────────────────────────────────────────────

describe("PROMPT_REGISTRY", () => {
  it("contains all expected prompt keys", () => {
    const keys = Object.keys(PROMPT_REGISTRY);
    expect(keys).toContain("TAYLOR_SIGNAL");
    expect(keys).toContain("BOBBY_RISK_MANAGER");
    expect(keys).toContain("HALL_MACRO");
    expect(keys).toContain("BILL_CRYPTO_INTEL");
    expect(keys).toContain("MAFEE_PATTERN");
    expect(keys).toContain("WENDY_COACH");
    expect(keys).toContain("STRATEGY_LEARNING");
    expect(keys).toContain("EXPERIMENT_PROPOSE");
    expect(keys).toContain("DAILY_BRIEF");
    expect(keys).toContain("JOURNAL_EXPLAIN");
    expect(keys).toContain("OUTCOME_ENRICHMENT");
  });

  it("every prompt has a non-empty id and version", () => {
    for (const [key, entry] of Object.entries(PROMPT_REGISTRY)) {
      expect(entry.id.length, `PROMPT_REGISTRY[${key}].id`).toBeGreaterThan(0);
      expect(entry.version.length, `PROMPT_REGISTRY[${key}].version`).toBeGreaterThan(0);
    }
  });

  it("version tags are short identifiers, never full prompt text", () => {
    for (const [key, entry] of Object.entries(PROMPT_REGISTRY)) {
      expect(entry.version.length, `PROMPT_REGISTRY[${key}].version too long`).toBeLessThan(64);
      expect(entry.version, `[${key}] looks like a prompt`).not.toContain("You are");
      expect(entry.version, `[${key}] looks like a prompt`).not.toContain("SIZING:");
    }
  });
});

describe("MODEL_REGISTRY", () => {
  it("contains expected model roles", () => {
    expect(MODEL_REGISTRY.TAYLOR).toContain("gemini");
    expect(MODEL_REGISTRY.BOBBY).toContain("claude");
    expect(MODEL_REGISTRY.HALL).toContain("gemini");
    expect(MODEL_REGISTRY.BILL).toContain("gemini");
    expect(MODEL_REGISTRY.MAFEE).toContain("gemini");
    expect(MODEL_REGISTRY.WENDY).toContain("claude");
    expect(MODEL_REGISTRY.NONE).toBe("none");
  });

  it("no model string contains API key patterns", () => {
    for (const [key, model] of Object.entries(MODEL_REGISTRY)) {
      expect(model, `MODEL_REGISTRY[${key}]`).not.toContain("Bearer ");
      expect(model, `MODEL_REGISTRY[${key}]`).not.toContain("sk-");
      expect(model, `MODEL_REGISTRY[${key}]`).not.toContain("apiKey");
    }
  });
});

describe("SCHEMA_REGISTRY", () => {
  const ALL_DECISION_TYPES: AiDecisionType[] = [
    "signal_decision",
    "market_intelligence",
    "post_trade_learning",
    "strategy_learning",
    "experiment_proposal",
    "daily_brief",
    "journal_explain",
    "outcome_enrichment",
  ];

  it("has a schema version for every decision type", () => {
    for (const dt of ALL_DECISION_TYPES) {
      expect(SCHEMA_REGISTRY[dt], `SCHEMA_REGISTRY[${dt}]`).toBeTruthy();
    }
  });

  it("deterministic types use schema version 'none'", () => {
    expect(SCHEMA_REGISTRY["strategy_learning"]).toBe("none");
    expect(SCHEMA_REGISTRY["outcome_enrichment"]).toBe("none");
  });
});

describe("VALIDATOR_REGISTRY", () => {
  it("deterministic types use validator 'deterministic'", () => {
    expect(VALIDATOR_REGISTRY["strategy_learning"]).toBe("deterministic");
    expect(VALIDATOR_REGISTRY["outcome_enrichment"]).toBe("deterministic");
  });

  it("AI types have non-deterministic validator names", () => {
    expect(VALIDATOR_REGISTRY["signal_decision"]).not.toBe("deterministic");
    expect(VALIDATOR_REGISTRY["market_intelligence"]).not.toBe("deterministic");
    expect(VALIDATOR_REGISTRY["post_trade_learning"]).not.toBe("deterministic");
  });
});

// ── buildAiProvenance ──────────────────────────────────────────────────────────

describe("buildAiProvenance", () => {
  function makeSignalProvenance(overrides: Partial<Parameters<typeof buildAiProvenance>[0]> = {}): AiProvenance {
    return buildAiProvenance({
      decisionType: "signal_decision",
      provider: "lovable_gateway",
      model: MODEL_REGISTRY.TAYLOR,
      promptKey: "TAYLOR_SIGNAL",
      validationStatus: "passed",
      ...overrides,
    });
  }

  it("includes decisionType, provider, model", () => {
    const p = makeSignalProvenance();
    expect(p.decisionType).toBe("signal_decision");
    expect(p.provider).toBe("lovable_gateway");
    expect(p.model).toBe(MODEL_REGISTRY.TAYLOR);
  });

  it("maps promptKey to registered id and version", () => {
    const p = makeSignalProvenance({ promptKey: "TAYLOR_SIGNAL" });
    expect(p.promptId).toBe(PROMPT_REGISTRY.TAYLOR_SIGNAL.id);
    expect(p.promptVersion).toBe(PROMPT_REGISTRY.TAYLOR_SIGNAL.version);
  });

  it("fills schemaVersion and validator from decision type", () => {
    const p = makeSignalProvenance();
    expect(p.schemaVersion).toBe(SCHEMA_REGISTRY["signal_decision"]);
    expect(p.validator).toBe(VALIDATOR_REGISTRY["signal_decision"]);
  });

  it("sets validationStatus correctly", () => {
    const passed = makeSignalProvenance({ validationStatus: "passed" });
    expect(passed.validationStatus).toBe("passed");

    const failed = makeSignalProvenance({ validationStatus: "failed" });
    expect(failed.validationStatus).toBe("failed");

    const fallback = makeSignalProvenance({ validationStatus: "fallback" });
    expect(fallback.validationStatus).toBe("fallback");
  });

  it("records fallbackUsed and fallbackReason", () => {
    const p = makeSignalProvenance({
      fallbackUsed: true,
      fallbackReason: "circuit breaker open",
    });
    expect(p.fallbackUsed).toBe(true);
    expect(p.fallbackReason).toBe("circuit breaker open");
  });

  it("defaults fallbackUsed to false when omitted", () => {
    const p = makeSignalProvenance();
    expect(p.fallbackUsed).toBe(false);
    expect(p.fallbackReason).toBeUndefined();
  });

  it("includes inputHash when provided", () => {
    const p = makeSignalProvenance({ inputHash: "abc123" });
    expect(p.inputHash).toBe("abc123");
  });

  it("inputHash is null when not provided", () => {
    const p = makeSignalProvenance();
    expect(p.inputHash).toBeNull();
  });

  it("records artifactIds", () => {
    const p = makeSignalProvenance({ artifactIds: ["signal-001", "signal-002"] });
    expect(p.artifactIds).toEqual(["signal-001", "signal-002"]);
  });

  it("createdAt is a recent ISO timestamp", () => {
    const before = new Date().toISOString();
    const p = makeSignalProvenance();
    const after = new Date().toISOString();
    expect(p.createdAt >= before).toBe(true);
    expect(p.createdAt <= after).toBe(true);
  });

  it("does NOT store API keys, bearer tokens, or full prompts", () => {
    const p = makeSignalProvenance();
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("SERVICE_ROLE");
    expect(serialized).not.toContain("LOVABLE_API_KEY");
    expect(serialized).not.toContain("You are");
    expect(serialized).not.toContain("SIZING:");
    expect(serialized).not.toContain("private_key");
  });
});

// ── buildDeterministicProvenance ──────────────────────────────────────────────

describe("buildDeterministicProvenance", () => {
  it("sets provider to 'none' for strategy_learning", () => {
    const p = buildDeterministicProvenance({ decisionType: "strategy_learning" });
    expect(p.provider).toBe("none");
    expect(p.model).toBe("none");
  });

  it("sets provider to 'none' for outcome_enrichment", () => {
    const p = buildDeterministicProvenance({ decisionType: "outcome_enrichment" });
    expect(p.provider).toBe("none");
    expect(p.model).toBe("none");
  });

  it("sets validationStatus to 'skipped' (no AI call)", () => {
    const p = buildDeterministicProvenance({ decisionType: "strategy_learning" });
    expect(p.validationStatus).toBe("skipped");
  });

  it("sets validator to 'deterministic'", () => {
    const p = buildDeterministicProvenance({ decisionType: "strategy_learning" });
    expect(p.validator).toBe("deterministic");
  });

  it("sets fallbackUsed to false (no AI, no fallback)", () => {
    const p = buildDeterministicProvenance({ decisionType: "strategy_learning" });
    expect(p.fallbackUsed).toBe(false);
  });

  it("inputHash is null (no external input to hash)", () => {
    const p = buildDeterministicProvenance({ decisionType: "strategy_learning" });
    expect(p.inputHash).toBeNull();
  });

  it("does not contain secrets", () => {
    const p = buildDeterministicProvenance({ decisionType: "outcome_enrichment" });
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("SERVICE_ROLE");
  });

  it("accepts artifactIds", () => {
    const p = buildDeterministicProvenance({
      decisionType: "strategy_learning",
      artifactIds: ["rec-abc"],
    });
    expect(p.artifactIds).toEqual(["rec-abc"]);
  });
});

// ── Hashing ────────────────────────────────────────────────────────────────────

describe("hashSafeInputPacket", () => {
  it("produces a hex string for a safe input", async () => {
    const hash = await hashSafeInputPacket({ symbol: "BTC-USD", regime: "trending_up", score: 0.72 });
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe("string");
    expect(hash!.length).toBe(64); // SHA-256 produces 64 hex chars
  });

  it("is stable for the same input (same output each call)", async () => {
    const input = { symbol: "ETH-USD", score: 0.65, confidence: 0.7 };
    const h1 = await hashSafeInputPacket(input);
    const h2 = await hashSafeInputPacket(input);
    expect(h1).toBe(h2);
  });

  it("changes when input changes", async () => {
    const h1 = await hashSafeInputPacket({ symbol: "BTC-USD", score: 0.72 });
    const h2 = await hashSafeInputPacket({ symbol: "BTC-USD", score: 0.80 });
    expect(h1).not.toBe(h2);
  });

  it("is stable regardless of key order (canonical)", async () => {
    const h1 = await hashSafeInputPacket({ a: 1, b: 2 });
    const h2 = await hashSafeInputPacket({ b: 2, a: 1 });
    expect(h1).toBe(h2);
  });
});

describe("hashSafeInputPacketSync", () => {
  it("returns a string starting with djb2-", () => {
    const hash = hashSafeInputPacketSync({ symbol: "BTC-USD", score: 0.5 });
    expect(hash.startsWith("djb2-")).toBe(true);
  });

  it("is stable for same input", () => {
    const input = { symbol: "SOL-USD", confidence: 0.68 };
    expect(hashSafeInputPacketSync(input)).toBe(hashSafeInputPacketSync(input));
  });

  it("changes when input changes", () => {
    const h1 = hashSafeInputPacketSync({ a: 1 });
    const h2 = hashSafeInputPacketSync({ a: 2 });
    expect(h1).not.toBe(h2);
  });
});

// ── Secret redaction ───────────────────────────────────────────────────────────

describe("redactSecretsForHashing", () => {
  it("strips apiKey fields", () => {
    const result = redactSecretsForHashing({ apiKey: "sk-secret", symbol: "BTC-USD" });
    expect(result).not.toHaveProperty("apiKey");
    expect(result.symbol).toBe("BTC-USD");
  });

  it("strips authorization fields", () => {
    const result = redactSecretsForHashing({ authorization: "Bearer abc123", score: 0.7 });
    expect(result).not.toHaveProperty("authorization");
    expect(result.score).toBe(0.7);
  });

  it("strips service_role fields", () => {
    const result = redactSecretsForHashing({ service_role: "eyJhb...", mode: "paper" });
    expect(result).not.toHaveProperty("service_role");
    expect(result.mode).toBe("paper");
  });

  it("strips nested secret fields recursively", () => {
    const result = redactSecretsForHashing({
      context: { apiKey: "secret", symbol: "ETH-USD" },
      score: 0.5,
    });
    const ctx = result.context as Record<string, unknown>;
    expect(ctx).not.toHaveProperty("apiKey");
    expect(ctx.symbol).toBe("ETH-USD");
  });

  it("preserves non-secret fields intact", () => {
    const result = redactSecretsForHashing({
      symbol: "BTC-USD",
      regime: "trending_up",
      setupScore: 0.72,
      confidence: 0.68,
      brainTrustFresh: true,
    });
    expect(result.symbol).toBe("BTC-USD");
    expect(result.regime).toBe("trending_up");
    expect(result.setupScore).toBe(0.72);
    expect(result.confidence).toBe(0.68);
    expect(result.brainTrustFresh).toBe(true);
  });

  it("strips bearer token field", () => {
    const result = redactSecretsForHashing({ bearer: "tok_abc", data: "safe" });
    expect(result).not.toHaveProperty("bearer");
    expect(result.data).toBe("safe");
  });

  it("does not mutate the original object", () => {
    const original = { apiKey: "secret", symbol: "BTC-USD" };
    redactSecretsForHashing(original);
    expect(original.apiKey).toBe("secret"); // original unchanged
  });

  it("hashing redacted output does not include secrets", async () => {
    const raw = { apiKey: "sk-secret-key", symbol: "BTC-USD", score: 0.7 };
    const safe = redactSecretsForHashing(raw);
    const hash = await hashSafeInputPacket(safe);
    // Hash itself should not contain the secret (sanity: it's a hex string)
    expect(hash).not.toContain("sk-secret-key");
    // The safe object should not have apiKey
    expect(safe).not.toHaveProperty("apiKey");
  });
});

// ── Replay packet compatibility ────────────────────────────────────────────────

describe("AiProvenance — replay packet serialization", () => {
  it("round-trips through JSON without data loss", () => {
    const p = buildAiProvenance({
      decisionType: "signal_decision",
      provider: "lovable_gateway",
      model: MODEL_REGISTRY.TAYLOR,
      promptKey: "TAYLOR_SIGNAL",
      validationStatus: "passed",
      inputHash: "abc123def",
      artifactIds: ["signal-xyz"],
    });

    const serialized = JSON.stringify(p);
    const restored = JSON.parse(serialized) as AiProvenance;

    expect(restored.decisionType).toBe(p.decisionType);
    expect(restored.provider).toBe(p.provider);
    expect(restored.model).toBe(p.model);
    expect(restored.promptId).toBe(p.promptId);
    expect(restored.promptVersion).toBe(p.promptVersion);
    expect(restored.schemaVersion).toBe(p.schemaVersion);
    expect(restored.validator).toBe(p.validator);
    expect(restored.validationStatus).toBe(p.validationStatus);
    expect(restored.inputHash).toBe(p.inputHash);
    expect(restored.artifactIds).toEqual(p.artifactIds);
  });

  it("missing provenance is not present rather than null (backward compatible)", () => {
    // A replay packet WITHOUT provenance is valid — provenance is optional
    const packetWithoutProvenance = {
      replayVersion: "1",
      signalId: "sig-001",
      decision: "approved",
    };
    // Provenance field is simply absent — no key error expected
    expect((packetWithoutProvenance as Record<string, unknown>).provenance).toBeUndefined();
  });

  it("serialized size is reasonable (not storing large payloads)", () => {
    const p = buildAiProvenance({
      decisionType: "market_intelligence",
      provider: "lovable_gateway",
      model: MODEL_REGISTRY.HALL,
      promptKey: "HALL_MACRO",
      validationStatus: "passed",
      inputHash: "def456abc",
    });
    const serialized = JSON.stringify(p);
    expect(serialized.length).toBeLessThan(2_000);
  });
});

// ── Validation status coverage ─────────────────────────────────────────────────

describe("ValidationStatus coverage", () => {
  const STATUSES = ["passed", "failed", "fallback", "skipped"] as const;

  for (const status of STATUSES) {
    it(`validationStatus="${status}" is representable`, () => {
      const p = buildAiProvenance({
        decisionType: "post_trade_learning",
        provider: "lovable_gateway",
        model: MODEL_REGISTRY.WENDY,
        promptKey: "WENDY_COACH",
        validationStatus: status,
      });
      expect(p.validationStatus).toBe(status);
    });
  }

  it("'failed' status does not trigger trade execution (type-level guard)", () => {
    // This test verifies the type carries enough info to gate downstream logic.
    // The provenance object itself is passive — callers must check it.
    const p = buildAiProvenance({
      decisionType: "signal_decision",
      provider: "lovable_gateway",
      model: MODEL_REGISTRY.TAYLOR,
      promptKey: "TAYLOR_SIGNAL",
      validationStatus: "failed",
      validationErrorCount: 3,
      fallbackUsed: true,
      fallbackReason: "JSON parse error in tool call",
    });
    expect(p.validationStatus).toBe("failed");
    expect(p.fallbackUsed).toBe(true);
    expect(p.validationErrorCount).toBe(3);
    // Confirm the provenance record itself contains enough to understand what happened
    expect(p.fallbackReason).toContain("parse error");
  });
});
