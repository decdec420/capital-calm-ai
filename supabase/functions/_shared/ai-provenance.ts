// ============================================================
// AI Provenance Registry — _shared edition (Deno-compatible)
// ------------------------------------------------------------
// Mirrors src/lib/ai-provenance.ts — kept in sync manually.
// Used by edge functions (signal-engine, market-intelligence,
// post-trade-learn, process-strategy-learning, etc.).
//
// Safety rules:
//   - NEVER store API keys, auth headers, or raw prompts.
//   - NEVER store bearer tokens or service role keys.
//   - DO store IDs, version tags, model names, and hashes.
//   - Deterministic / non-AI code is explicitly marked provider="none".
// ============================================================

// ── Decision types ────────────────────────────────────────────────────────────

export type AiDecisionType =
  | "signal_decision"
  | "market_intelligence"
  | "post_trade_learning"
  | "strategy_learning"
  | "experiment_proposal"
  | "daily_brief"
  | "journal_explain"
  | "outcome_enrichment";

// ── Provider / model registry ─────────────────────────────────────────────────

export type AiProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "lovable_gateway"
  | "none";

export const PROMPT_REGISTRY = {
  TAYLOR_SIGNAL:        { id: "taylor-signal",        version: "signal-engine-v2" },
  BOBBY_RISK_MANAGER:   { id: "bobby-risk-manager",   version: "risk-manager-v1"  },
  HALL_MACRO:           { id: "hall-macro",            version: "brain-trust-v1"   },
  BILL_CRYPTO_INTEL:    { id: "bill-crypto-intel",     version: "brain-trust-v1"   },
  MAFEE_PATTERN:        { id: "mafee-pattern",         version: "brain-trust-v1"   },
  WENDY_COACH:          { id: "wendy-coach",           version: "post-trade-v1"    },
  STRATEGY_LEARNING:    { id: "strategy-learning",     version: "none"             },
  EXPERIMENT_PROPOSE:   { id: "experiment-propose",    version: "propose-v1"       },
  DAILY_BRIEF:          { id: "daily-brief",           version: "brief-v1"         },
  JOURNAL_EXPLAIN:      { id: "journal-explain",       version: "explain-v1"       },
  OUTCOME_ENRICHMENT:   { id: "outcome-enrichment",    version: "none"             },
} as const;

export type PromptKey = keyof typeof PROMPT_REGISTRY;

export const MODEL_REGISTRY = {
  TAYLOR:           "google/gemini-3-flash-preview",
  BOBBY:            "anthropic/claude-sonnet-4-6",
  HALL:             "google/gemini-2.5-flash",
  BILL:             "google/gemini-2.5-flash",
  MAFEE:            "google/gemini-2.5-flash-lite",
  WENDY:            "anthropic/claude-sonnet-4-6",
  EXPERIMENT:       "google/gemini-3-flash-preview",
  DAILY_BRIEF:      "google/gemini-2.5-flash",
  JOURNAL_EXPLAIN:  "google/gemini-3-flash-preview",
  NONE:             "none",
} as const;

export type ModelKey = keyof typeof MODEL_REGISTRY;

export const SCHEMA_REGISTRY: Record<AiDecisionType, string> = {
  signal_decision:      "submit_decision-v1",
  market_intelligence:  "brain-trust-expert-v1",
  post_trade_learning:  "wendy_grade_trade-v1",
  strategy_learning:    "none",
  experiment_proposal:  "experiment_proposal-v1",
  daily_brief:          "daily_brief-v1",
  journal_explain:      "journal_explain-v1",
  outcome_enrichment:   "none",
};

export const VALIDATOR_REGISTRY: Record<AiDecisionType, string> = {
  signal_decision:      "parse-submit-decision",
  market_intelligence:  "parse-brain-trust-expert",
  post_trade_learning:  "parse-wendy-grade-trade",
  strategy_learning:    "deterministic",
  experiment_proposal:  "parse-experiment-proposal",
  daily_brief:          "parse-daily-brief",
  journal_explain:      "parse-journal-explain",
  outcome_enrichment:   "deterministic",
};

// ── Provenance object ─────────────────────────────────────────────────────────

export type ValidationStatus =
  | "passed"
  | "failed"
  | "fallback"
  | "skipped";

/**
 * AI provenance record attached to a decision or learning artifact.
 *
 * Security invariants:
 *   - NEVER include API keys, bearer tokens, or auth headers.
 *   - NEVER include raw prompt text.
 *   - inputHash / outputHash are sha-256 of sanitized non-secret fields only.
 */
export interface AiProvenance {
  decisionType: AiDecisionType;
  provider: AiProvider;
  model: string;
  promptId: string;
  promptVersion: string;
  schemaVersion: string;
  validator: string;
  validationStatus: ValidationStatus;
  validationErrorCount: number;
  fallbackUsed: boolean;
  fallbackReason?: string;
  inputHash: string | null;
  outputHash?: string | null;
  createdAt: string;
  artifactIds?: string[];
}

// ── Builder helpers ───────────────────────────────────────────────────────────

export function buildAiProvenance(params: {
  decisionType: AiDecisionType;
  provider: AiProvider;
  model: string;
  promptKey: PromptKey;
  validationStatus: ValidationStatus;
  validationErrorCount?: number;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  inputHash?: string | null;
  outputHash?: string | null;
  artifactIds?: string[];
}): AiProvenance {
  const prompt = PROMPT_REGISTRY[params.promptKey];
  return {
    decisionType: params.decisionType,
    provider: params.provider,
    model: params.model,
    promptId: prompt.id,
    promptVersion: prompt.version,
    schemaVersion: SCHEMA_REGISTRY[params.decisionType],
    validator: VALIDATOR_REGISTRY[params.decisionType],
    validationStatus: params.validationStatus,
    validationErrorCount: params.validationErrorCount ?? 0,
    fallbackUsed: params.fallbackUsed ?? false,
    fallbackReason: params.fallbackReason,
    inputHash: params.inputHash ?? null,
    outputHash: params.outputHash ?? null,
    createdAt: new Date().toISOString(),
    artifactIds: params.artifactIds,
  };
}

export function buildDeterministicProvenance(params: {
  decisionType: AiDecisionType;
  artifactIds?: string[];
}): AiProvenance {
  const promptKey: PromptKey =
    params.decisionType === "strategy_learning" ? "STRATEGY_LEARNING"
    : "OUTCOME_ENRICHMENT";
  return {
    decisionType: params.decisionType,
    provider: "none",
    model: MODEL_REGISTRY.NONE,
    promptId: PROMPT_REGISTRY[promptKey].id,
    promptVersion: "none",
    schemaVersion: SCHEMA_REGISTRY[params.decisionType],
    validator: "deterministic",
    validationStatus: "skipped",
    validationErrorCount: 0,
    fallbackUsed: false,
    inputHash: null,
    createdAt: new Date().toISOString(),
    artifactIds: params.artifactIds,
  };
}

// ── Input hashing ─────────────────────────────────────────────────────────────

/**
 * Compute a stable SHA-256 hex hash of a non-secret input packet.
 * Strip all credential fields before calling (use redactSecretsForHashing).
 */
export async function hashSafeInputPacket(
  safeFields: Record<string, unknown>,
): Promise<string | null> {
  try {
    const canonical = JSON.stringify(canonicalizeObject(safeFields));
    const encoded = new TextEncoder().encode(canonical);
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b: number) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/**
 * Strip known credential / secret fields before hashing.
 * Returns a new object — does not mutate the input.
 */
export function redactSecretsForHashing(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const SECRET_KEY_PATTERNS = [
    "apikey", "api_key", "apiKey",
    "secret", "token", "password", "passwd",
    "authorization", "auth",
    "bearer", "credential", "credentials",
    "private_key", "privatekey", "privateKey",
    "service_role", "serviceRole",
    "lovable_api_key", "lovableApiKey",
    "coinbase_api", "coinbaseApi",
  ];

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const lowerKey = key.toLowerCase();
    const isSecret = SECRET_KEY_PATTERNS.some((p) => lowerKey.includes(p.toLowerCase()));
    if (isSecret) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactSecretsForHashing(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function canonicalizeObject(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(canonicalizeObject);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = canonicalizeObject((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}
