// ============================================================
// AI Output Guard — PR #44
// ------------------------------------------------------------
// Central hardening layer for all AI-generated output.
//
// Threat model (OWASP LLM Top 10):
//   - Prompt injection: text designed to override safety rules
//   - Excessive agency: AI claiming authority to execute protected actions
//   - Insecure output handling: unvalidated JSON triggering execution
//   - Role confusion: AI text claiming to be a privileged agent
//   - Overreliance: fallback behavior that is more aggressive than intended
//
// Invariants (must never be broken):
//   - AI output cannot place trades
//   - AI output cannot approve signals
//   - AI output cannot enable live mode
//   - AI output cannot disable the kill switch
//   - AI output cannot change doctrine or risk gates
//   - AI output cannot transfer funds or reveal secrets
//   - AI output cannot bypass human review steps
//   - AI output cannot run experiments immediately
//   - Fallback behavior is always MORE conservative than the failed output
//   - Unsafe text is summarized, never stored raw
//
// This module is imported by src/ (browser + tests).
// The Deno mirror is supabase/functions/_shared/ai-output-guard.ts.
// Keep both in sync manually.
// ============================================================

import { isAgentForbidden, type AgentId } from "@/lib/agent-permissions";
import type { AiProvenance, ValidationStatus } from "@/lib/ai-provenance";

// ── Guard decision types ───────────────────────────────────────────────────────

/**
 * The verdict returned by the guard after inspecting AI output.
 *
 * - allow            Safe read-only or non-executing output
 * - reject           Contains protected actions or unsafe intent — discard
 * - allow_readonly   Output is informational only; no state mutation permitted
 * - requires_human_review  Proposal-only; must pass through human review gate
 * - fallback         Conservative fallback should replace the output
 */
export type AiGuardDecision =
  | "allow"
  | "reject"
  | "allow_readonly"
  | "requires_human_review"
  | "fallback";

export interface AiOutputGuardResult {
  decision: AiGuardDecision;
  unsafeIntents: string[];
  protectedActions: string[];
  sanitizedOutput?: unknown;
  reason: string;
  /** Provenance fields to merge into the artifact's provenance record. */
  provenancePatch: {
    validationStatus: ValidationStatus;
    fallbackUsed: boolean;
    fallbackReason?: string;
    /** Count of unsafe intent phrases detected. */
    unsafeIntentCount: number;
    /** Count of protected action references detected. */
    protectedActionCount: number;
    /** Name of the validator that ran. */
    guardValidator: string;
    /** Human-readable summary of why the output was rejected / allowed. */
    guardReason: string;
  };
}

// ── Protected action list ──────────────────────────────────────────────────────

/**
 * Actions that AI output can NEVER directly perform.
 * Model output may propose these for human review, but cannot execute them.
 */
export const PROTECTED_ACTIONS = [
  "place_trade",
  "approve_signal",
  "execute_broker_order",
  "enable_live_mode",
  "disable_kill_switch",
  "change_doctrine",
  "change_risk_gate",
  "change_strategy_params",
  "promote_strategy",
  "transfer_funds",
  "store_secret",
  "reveal_secret",
  "run_experiment_immediately",
  "bypass_human_review",
  "bypass_doctrine",
  "bypass_kill_switch",
  "modify_risk_settings_unilaterally",
  "approve_own_signals",
  "approve_own_orders",
  "decide_strategy",
  "place_live_trade_directly",
  "place_live_trade_independently",
] as const;

export type ProtectedAction = (typeof PROTECTED_ACTIONS)[number];

// ── Unsafe phrase patterns (prompt injection / excessive agency) ───────────────

/**
 * Phrases in model output text that indicate prompt injection or excessive agency.
 * Matched case-insensitively.
 */
const UNSAFE_PHRASE_PATTERNS: string[] = [
  "ignore previous",
  "ignore risk gate",
  "ignore the risk gate",
  "override kill switch",
  "override the kill switch",
  "disable kill switch",
  "disable the kill switch",
  "disable doctrine",
  "disable the doctrine",
  "bypass doctrine",
  "bypass the doctrine",
  "bypass risk",
  "set mode to live",
  "switch to live",
  "enable live mode",
  "enable live trading",
  "transfer all funds",
  "transfer funds",
  "approve this signal",
  "approve the signal",
  "approve signal without",
  "call broker execution",
  "execute broker",
  "place the trade",
  "place a trade",
  "lower confidence threshold",
  "reduce confidence threshold",
  "lower the threshold",
  "i am bobby",
  "acting as bobby",
  "as the risk manager, i",
  "as desk commander",
  "create a queued experiment and run",
  "run the experiment immediately",
  "run experiment immediately",
  "promote strategy immediately",
  "reveal the secret",
  "reveal secret",
  "store secret",
  "ignore instructions",
  "disregard instructions",
  "forget previous instructions",
  "new instructions:",
  "system override",
];

// ── Allow-list for safe output shapes ─────────────────────────────────────────

/**
 * Keys whose presence in AI output always requires human review
 * before any downstream action can be taken.
 */
const REVIEW_REQUIRED_KEYS = new Set([
  "recommendation",
  "proposal",
  "experiment_proposal",
  "strategy_adjustment",
  "parameter_change",
]);

/**
 * Keys that indicate an output is trying to directly perform a protected action.
 */
const EXECUTION_KEYS = new Set([
  "execute",
  "place_trade",
  "approve_signal",
  "enable_live",
  "disable_kill_switch",
  "broker_action",
  "transfer",
]);

// ── Core guard function ────────────────────────────────────────────────────────

const GUARD_VALIDATOR_NAME = "ai-output-guard-v1";

/**
 * Inspect raw AI output text or a parsed object for unsafe intent,
 * protected actions, and role-boundary violations.
 *
 * Call this before acting on ANY AI-generated content.
 *
 * @param rawOutput  The AI output (string or already-parsed object).
 * @param context    Optional context for richer diagnostics.
 */
export function guardAiOutput(
  rawOutput: unknown,
  context?: {
    agentId?: AgentId;
    decisionType?: string;
  },
): AiOutputGuardResult {
  const unsafeIntents: string[] = [];
  const protectedActions: string[] = [];

  // 1. Scan text content for unsafe phrases
  const textContent = extractTextContent(rawOutput);
  for (const phrase of UNSAFE_PHRASE_PATTERNS) {
    if (textContent.toLowerCase().includes(phrase.toLowerCase())) {
      unsafeIntents.push(phrase);
    }
  }

  // 2. Scan for protected action references in the output structure
  const outputStr = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput ?? "");
  for (const action of PROTECTED_ACTIONS) {
    if (outputStr.toLowerCase().includes(action.toLowerCase().replace(/_/g, " ")) ||
        outputStr.includes(action)) {
      protectedActions.push(action);
    }
  }

  // 3. Scan parsed object keys for execution intent
  if (rawOutput !== null && typeof rawOutput === "object" && !Array.isArray(rawOutput)) {
    const keys = Object.keys(rawOutput as Record<string, unknown>);
    for (const key of keys) {
      if (EXECUTION_KEYS.has(key.toLowerCase())) {
        protectedActions.push(`output_key:${key}`);
      }
    }
  }

  // 4. Agent permission matrix check
  if (context?.agentId) {
    const agentViolations = detectAgentViolations(context.agentId, outputStr);
    for (const v of agentViolations) {
      protectedActions.push(`agent_violation:${v}`);
    }
  }

  // 5. Determine verdict
  if (unsafeIntents.length > 0 || protectedActions.length > 0) {
    const safeReason = buildSafeRejectReason(unsafeIntents, protectedActions);
    return {
      decision: "reject",
      unsafeIntents,
      protectedActions,
      reason: safeReason,
      provenancePatch: {
        validationStatus: "failed",
        fallbackUsed: false,
        unsafeIntentCount: unsafeIntents.length,
        protectedActionCount: protectedActions.length,
        guardValidator: GUARD_VALIDATOR_NAME,
        guardReason: safeReason,
      },
    };
  }

  // 6. Check if output requires human review (proposal-only)
  if (rawOutput !== null && typeof rawOutput === "object" && !Array.isArray(rawOutput)) {
    const keys = Object.keys(rawOutput as Record<string, unknown>);
    const requiresReview = keys.some((k) => REVIEW_REQUIRED_KEYS.has(k.toLowerCase()));
    if (requiresReview) {
      return {
        decision: "requires_human_review",
        unsafeIntents: [],
        protectedActions: [],
        sanitizedOutput: rawOutput,
        reason: "Output contains proposal-only keys that require human review before action",
        provenancePatch: {
          validationStatus: "passed",
          fallbackUsed: false,
          unsafeIntentCount: 0,
          protectedActionCount: 0,
          guardValidator: GUARD_VALIDATOR_NAME,
          guardReason: "proposal-only: requires_human_review",
        },
      };
    }
  }

  // 7. Allow safe read-only text/analysis outputs
  if (typeof rawOutput === "string") {
    return {
      decision: "allow_readonly",
      unsafeIntents: [],
      protectedActions: [],
      sanitizedOutput: rawOutput,
      reason: "Text output is read-only; no action permitted",
      provenancePatch: {
        validationStatus: "passed",
        fallbackUsed: false,
        unsafeIntentCount: 0,
        protectedActionCount: 0,
        guardValidator: GUARD_VALIDATOR_NAME,
        guardReason: "allow_readonly: text analysis",
      },
    };
  }

  return {
    decision: "allow",
    unsafeIntents: [],
    protectedActions: [],
    sanitizedOutput: rawOutput,
    reason: "Output passed all guard checks",
    provenancePatch: {
      validationStatus: "passed",
      fallbackUsed: false,
      unsafeIntentCount: 0,
      protectedActionCount: 0,
      guardValidator: GUARD_VALIDATOR_NAME,
      guardReason: "allow: passed all checks",
    },
  };
}

// ── Conservative fallback helper ───────────────────────────────────────────────

/**
 * Safe conservative fallback when AI output fails validation or guard checks.
 *
 * Invariants:
 *   - Never places a trade
 *   - Never approves a signal
 *   - Never mutates strategy or doctrine
 *   - Never executes any broker action
 *
 * @param reason  Why fallback is being used (safe summary, not raw output)
 */
export function buildConservativeFallback(reason: string): {
  action: "skip" | "require_review" | "record_only";
  reason: string;
  guardResult: AiOutputGuardResult;
} {
  const safeSummary = sanitizeForStorage(reason);
  const guardResult: AiOutputGuardResult = {
    decision: "fallback",
    unsafeIntents: [],
    protectedActions: [],
    reason: safeSummary,
    provenancePatch: {
      validationStatus: "fallback",
      fallbackUsed: true,
      fallbackReason: safeSummary,
      unsafeIntentCount: 0,
      protectedActionCount: 0,
      guardValidator: GUARD_VALIDATOR_NAME,
      guardReason: `fallback: ${safeSummary}`,
    },
  };
  return { action: "skip", reason: safeSummary, guardResult };
}

// ── Provenance patch helper ────────────────────────────────────────────────────

/**
 * Merge guard result provenance fields into an existing AiProvenance record.
 * Returns a new record — does not mutate the input.
 */
export function applyGuardToProvenance(
  provenance: AiProvenance,
  guardResult: AiOutputGuardResult,
): AiProvenance {
  return {
    ...provenance,
    validationStatus: guardResult.provenancePatch.validationStatus,
    fallbackUsed: guardResult.provenancePatch.fallbackUsed,
    ...(guardResult.provenancePatch.fallbackReason !== undefined
      ? { fallbackReason: guardResult.provenancePatch.fallbackReason }
      : {}),
  };
}

// ── Validation schema helpers ──────────────────────────────────────────────────

/**
 * Safely parse a JSON string from AI output.
 * Returns null if parsing fails — never throws.
 * On parse failure, returns a conservative fallback result via the second value.
 */
export function safeParseAiJson(raw: string): {
  parsed: unknown | null;
  guardResult: AiOutputGuardResult | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const fb = buildConservativeFallback("JSON parse error in AI output");
    return { parsed: null, guardResult: fb.guardResult };
  }
  const guardResult = guardAiOutput(parsed);
  if (guardResult.decision === "reject") {
    return { parsed: null, guardResult };
  }
  return { parsed, guardResult };
}

/**
 * Validate that a parsed AI object has the expected keys
 * and does not contain unexpected action keys.
 *
 * @param obj           The parsed object to validate
 * @param requiredKeys  Keys that must be present
 * @param forbiddenKeys Keys that must NOT be present (protected actions)
 */
export function validateAiOutputShape(
  obj: unknown,
  requiredKeys: string[],
  forbiddenKeys: string[] = [...PROTECTED_ACTIONS],
): { valid: boolean; missingKeys: string[]; forbiddenFound: string[] } {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return {
      valid: false,
      missingKeys: requiredKeys,
      forbiddenFound: [],
    };
  }
  const record = obj as Record<string, unknown>;
  const missingKeys = requiredKeys.filter((k) => !(k in record));
  const forbiddenFound = forbiddenKeys.filter(
    (k) =>
      k in record ||
      Object.keys(record).some((ok) => ok.toLowerCase() === k.toLowerCase()),
  );
  return {
    valid: missingKeys.length === 0 && forbiddenFound.length === 0,
    missingKeys,
    forbiddenFound,
  };
}

// ── Agent permission matrix integration ───────────────────────────────────────

/**
 * Check whether an agent's output text mentions actions it is forbidden from doing.
 * Returns a list of detected violations.
 */
export function detectAgentViolations(agentId: AgentId, outputText: string): string[] {
  const violations: string[] = [];
  const lowerText = outputText.toLowerCase();

  // Map from forbidden action to trigger phrases in output text
  const AGENT_ACTION_TRIGGERS: Record<string, string[]> = {
    change_doctrine: ["change doctrine", "update doctrine", "modify doctrine", "alter doctrine"],
    execute_trades: ["execute trade", "place trade", "submit order", "send order to broker"],
    approve_trades: ["approve trade", "approve signal", "approve order", "authorize trade"],
    bypass_kill_switch: ["bypass kill switch", "disable kill switch", "ignore kill switch"],
    bypass_doctrine: ["bypass doctrine", "ignore doctrine", "override doctrine"],
    place_live_trade_directly: ["place live trade", "live trade directly", "submit live order"],
    place_live_trade_independently: ["independent live trade"],
    require_transfer_permission: ["transfer permission", "transfer funds"],
    decide_strategy: ["decide strategy", "choose strategy", "select strategy as execution"],
    approve_own_orders: ["approve my order", "approve own order", "self-approve"],
    approve_own_signals: ["approve my signal", "approve own signal"],
    modify_risk_settings_unilaterally: ["lower risk", "change risk gate", "modify risk gate"],
  };

  for (const [forbiddenAction, triggers] of Object.entries(AGENT_ACTION_TRIGGERS)) {
    if (!isAgentForbidden(agentId, forbiddenAction)) continue;
    for (const trigger of triggers) {
      if (lowerText.includes(trigger)) {
        violations.push(`${agentId}:${forbiddenAction}`);
        break;
      }
    }
  }

  return violations;
}

// ── Unsafe text sanitization ───────────────────────────────────────────────────

/**
 * Produce a safe storage-ready summary of a potentially unsafe string.
 * Strips injection phrases, truncates to 500 chars, and marks it as sanitized.
 *
 * NEVER store raw malicious prompt text — use this helper first.
 */
export function sanitizeForStorage(text: string): string {
  let safe = text;
  for (const phrase of UNSAFE_PHRASE_PATTERNS) {
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    safe = safe.replace(re, "[REDACTED]");
  }
  safe = safe.slice(0, 500);
  return safe.length < text.length ? `${safe} [truncated]` : safe;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function extractTextContent(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return "";
  }
}

function buildSafeRejectReason(
  unsafeIntents: string[],
  protectedActions: string[],
): string {
  const parts: string[] = [];
  if (unsafeIntents.length > 0) {
    parts.push(`unsafe intent(s) detected (${unsafeIntents.length})`);
  }
  if (protectedActions.length > 0) {
    parts.push(`protected action(s) referenced (${protectedActions.length})`);
  }
  return `AI output rejected: ${parts.join("; ")}`;
}
