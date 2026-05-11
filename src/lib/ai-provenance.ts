// ============================================================
// AI Provenance Registry — PR #43
// ------------------------------------------------------------
// Central registry of AI decision types, prompt IDs, model
// assignments, schema versions, and output validators.
//
// Safety rules:
//   - NEVER store API keys, auth headers, or raw prompts.
//   - NEVER store bearer tokens or service role keys.
//   - DO store IDs, version tags, model names, and hashes.
//   - Deterministic / non-AI code is explicitly marked provider="none".
//
// This module is imported by src/ (browser + tests).
// The Deno mirror is supabase/functions/_shared/ai-provenance.ts.
// Keep both in sync manually.
// ============================================================

// ── Decision types ────────────────────────────────────────────────────────────

export type AiDecisionType =
  | "signal_decision"          // Taylor + Bobby: tick-level trade proposal
  | "market_intelligence"      // Hall + Bill + Mafee: Brain Trust brief
  | "post_trade_learning"      // Wendy: per-trade coaching + grading
  | "strategy_learning"        // process-strategy-learning: pattern rec
  | "experiment_proposal"      // propose-experiment: parameter hypothesis
  | "daily_brief"              // daily-brief: morning digest
  | "journal_explain"          // journal-explain: trade narrative
  | "outcome_enrichment"       // outcome-enrichment: deterministic math
  | "market_brief"             // market-brief: terse per-session trader brief
  | "signal_explain"           // signal-explain: deep-dive signal rationale
  | "copilot_chat"             // copilot-chat: Wags operator assistant turn
  | "bobby_orchestration";     // jessica: Bobby autonomous desk tick

// ── Provider / model registry ─────────────────────────────────────────────────

export type AiProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "lovable_gateway"   // proxied via ai.gateway.lovable.dev
  | "none";             // deterministic — no AI call

/** Registered prompt IDs with stable version tags. */
export const PROMPT_REGISTRY = {
  // Signal engine
  TAYLOR_SIGNAL:        { id: "taylor-signal",        version: "signal-engine-v2" },
  BOBBY_RISK_MANAGER:   { id: "bobby-risk-manager",   version: "risk-manager-v1"  },
  // Brain Trust
  HALL_MACRO:           { id: "hall-macro",            version: "brain-trust-v1"   },
  BILL_CRYPTO_INTEL:    { id: "bill-crypto-intel",     version: "brain-trust-v1"   },
  MAFEE_PATTERN:        { id: "mafee-pattern",         version: "brain-trust-v1"   },
  // Post-trade
  WENDY_COACH:          { id: "wendy-coach",           version: "post-trade-v1"    },
  // Strategy learning + experiments
  STRATEGY_LEARNING:    { id: "strategy-learning",     version: "none"             },
  EXPERIMENT_PROPOSE:   { id: "experiment-propose",    version: "propose-v1"       },
  // Briefs + explain
  DAILY_BRIEF:          { id: "daily-brief",           version: "brief-v1"         },
  JOURNAL_EXPLAIN:      { id: "journal-explain",       version: "explain-v1"       },
  // Lower-risk surfaces
  MARKET_BRIEF:         { id: "market-brief",          version: "market-brief-v1"  },
  SIGNAL_EXPLAIN:       { id: "signal-explain",        version: "explain-v1"       },
  COPILOT_CHAT:         { id: "copilot-chat",          version: "wags-v1"          },
  BOBBY_ORCHESTRATION:  { id: "bobby-orchestration",   version: "bobby-v1"         },
  // Deterministic
  OUTCOME_ENRICHMENT:   { id: "outcome-enrichment",    version: "none"             },
} as const;

export type PromptKey = keyof typeof PROMPT_REGISTRY;

/** Registered model identifiers per role (no credentials). */
export const MODEL_REGISTRY = {
  TAYLOR:              "google/gemini-3-flash-preview",
  BOBBY:               "anthropic/claude-sonnet-4-6",
  HALL:                "google/gemini-2.5-flash",
  BILL:                "google/gemini-2.5-flash",
  MAFEE:               "google/gemini-2.5-flash-lite",
  WENDY:               "anthropic/claude-sonnet-4-6",
  EXPERIMENT:          "google/gemini-3-flash-preview",
  DAILY_BRIEF:         "google/gemini-2.5-flash",
  JOURNAL_EXPLAIN:     "google/gemini-3-flash-preview",
  MARKET_BRIEF:        "google/gemini-2.5-flash-lite",
  SIGNAL_EXPLAIN:      "google/gemini-3-flash-preview",
  WAGS:                "google/gemini-3-flash-preview",
  BOBBY_ORCHESTRATION: "google/gemini-2.0-flash-001",
  NONE:                "none",
} as const;

export type ModelKey = keyof typeof MODEL_REGISTRY;

/** Registered output schema versions per decision type. */
export const SCHEMA_REGISTRY: Record<AiDecisionType, string> = {
  signal_decision:      "submit_decision-v1",
  market_intelligence:  "brain-trust-expert-v1",
  post_trade_learning:  "wendy_grade_trade-v1",
  strategy_learning:    "none",
  experiment_proposal:  "experiment_proposal-v1",
  daily_brief:          "daily_brief-v1",
  journal_explain:      "journal_explain-v1",
  outcome_enrichment:   "none",
  market_brief:         "market_brief-v1",
  signal_explain:       "signal_explain-v1",
  copilot_chat:         "copilot_chat-v1",
  bobby_orchestration:  "none",
};

/** Validator name for each decision type (links to validation logic). */
export const VALIDATOR_REGISTRY: Record<AiDecisionType, string> = {
  signal_decision:      "parse-submit-decision",
  market_intelligence:  "parse-brain-trust-expert",
  post_trade_learning:  "parse-wendy-grade-trade",
  strategy_learning:    "deterministic",
  experiment_proposal:  "parse-experiment-proposal",
  daily_brief:          "parse-daily-brief",
  journal_explain:      "parse-journal-explain",
  outcome_enrichment:   "deterministic",
  market_brief:         "parse-market-brief",
  signal_explain:       "parse-signal-explain",
  copilot_chat:         "parse-copilot-chat",
  bobby_orchestration:  "deterministic",
};

// ── Provenance object ─────────────────────────────────────────────────────────

/** Validation status for an AI output. */
export type ValidationStatus =
  | "passed"    // Output parsed successfully against schema
  | "failed"    // Output failed schema parse — no action taken
  | "fallback"  // Fallback behavior was used (model unavailable, parse error)
  | "skipped";  // Validation was not attempted (deterministic path)

/**
 * AI provenance record attached to a decision or learning artifact.
 *
 * Security invariants:
 *   - NEVER include API keys, bearer tokens, or auth headers.
 *   - NEVER include raw prompt text (promptId/promptVersion only).
 *   - NEVER include raw candle arrays or large inputs.
 *   - inputHash / outputHash are sha-256 of sanitized non-secret fields only.
 */
export interface AiProvenance {
  /** What kind of decision this was. */
  decisionType: AiDecisionType;
  /** AI provider or "none" for deterministic. */
  provider: AiProvider;
  /** Model identifier string — no credentials. */
  model: string;
  /** Stable prompt ID from PROMPT_REGISTRY. */
  promptId: string;
  /** Version tag from PROMPT_REGISTRY — never full prompt text. */
  promptVersion: string;
  /** Output schema version from SCHEMA_REGISTRY. */
  schemaVersion: string;
  /** Validator name from VALIDATOR_REGISTRY. */
  validator: string;
  /** Whether output parsing succeeded, failed, fell back, or was skipped. */
  validationStatus: ValidationStatus;
  /** Number of validation errors (0 for passed/skipped). */
  validationErrorCount: number;
  /** Whether fallback behavior was used due to model/parse failure. */
  fallbackUsed: boolean;
  /** Why fallback was used, if applicable. */
  fallbackReason?: string;
  /** SHA-256 hex of the non-secret, canonicalized input fields. Null if no safe input. */
  inputHash: string | null;
  /** SHA-256 hex of the validated output, if available. */
  outputHash?: string | null;
  /** ISO timestamp when provenance was recorded. */
  createdAt: string;
  /**
   * Artifact IDs this provenance influenced (signal ID, recommendation ID, etc.).
   * One or more artifact references — what was created or modified.
   */
  artifactIds?: string[];
}

// ── Builder helpers ───────────────────────────────────────────────────────────

/**
 * Build a provenance record for a live AI call.
 * Call after the AI response is parsed so validationStatus reflects reality.
 */
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

/**
 * Build a provenance record for a deterministic (non-AI) code path.
 * Used to explicitly mark that no model was involved.
 */
export function buildDeterministicProvenance(params: {
  decisionType: AiDecisionType;
  artifactIds?: string[];
}): AiProvenance {
  return {
    decisionType: params.decisionType,
    provider: "none",
    model: MODEL_REGISTRY.NONE,
    promptId: PROMPT_REGISTRY[
      params.decisionType === "strategy_learning" ? "STRATEGY_LEARNING"
      : params.decisionType === "outcome_enrichment" ? "OUTCOME_ENRICHMENT"
      : "OUTCOME_ENRICHMENT"  // safe default for any other deterministic type
    ].id,
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
 *
 * Rules for callers:
 *   - Strip ALL credential fields before calling (apiKey, auth, secret, token).
 *   - Strip user PII fields (email, full name) if not needed for audit.
 *   - Only include fields required to reproduce the decision (prices, regime, scores).
 *   - Canonicalize: sort object keys before stringifying for stability.
 *
 * Returns null if the Web Crypto API is unavailable (e.g. older test environments).
 */
export async function hashSafeInputPacket(
  safeFields: Record<string, unknown>,
): Promise<string | null> {
  try {
    const canonical = JSON.stringify(canonicalizeObject(safeFields));
    const encoded = new TextEncoder().encode(canonical);
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/**
 * Synchronous hash using a simple djb2-like function for environments
 * where crypto.subtle is unavailable (e.g. certain test runtimes).
 * Less cryptographically strong — use hashSafeInputPacket when possible.
 */
export function hashSafeInputPacketSync(
  safeFields: Record<string, unknown>,
): string {
  const canonical = JSON.stringify(canonicalizeObject(safeFields));
  let hash = 5381;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) + hash) ^ canonical.charCodeAt(i);
    hash = hash >>> 0; // convert to unsigned 32-bit
  }
  return `djb2-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Recursively sort object keys for stable JSON serialization.
 * Arrays are preserved in order (order matters for sequences).
 */
function canonicalizeObject(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(canonicalizeObject);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = canonicalizeObject((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Strip known credential / secret fields from an object before hashing.
 * Call this on any external input before passing to hashSafeInputPacket.
 *
 * Redacts (removes) any key matching the secret patterns list.
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
    if (isSecret) continue; // redact
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactSecretsForHashing(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
