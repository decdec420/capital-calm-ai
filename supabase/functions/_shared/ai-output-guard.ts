// ============================================================
// AI Output Guard — _shared edition (Deno-compatible)
// ------------------------------------------------------------
// Mirrors src/lib/ai-output-guard.ts — kept in sync manually.
// Used by edge functions (signal-engine, market-intelligence,
// post-trade-learn, process-strategy-learning, propose-experiment, etc.).
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
// ============================================================

import type { AiProvenance, ValidationStatus } from "./ai-provenance.ts";

// Inline AgentId + isAgentForbidden — agent-permissions.ts has no Deno mirror yet.
// Keep this in sync with src/lib/agent-permissions.ts.
type AgentId =
  | "bobby" | "taylor" | "brainTrust" | "wendy"
  | "hall" | "wags" | "brokerGateway" | "riskDoctrine";

const AGENT_FORBIDDEN: Record<AgentId, readonly string[]> = {
  bobby:        ["bypass_doctrine","bypass_kill_switch_without_audited_recovery","place_live_trade_directly","require_transfer_permission","modify_risk_settings_unilaterally"],
  taylor:       ["change_doctrine","change_risk_settings","approve_own_signals","bypass_risk_gates","require_transfer_permission"],
  brainTrust:   ["execute_trades","approve_trades","change_doctrine","issue_bobby_directives","require_transfer_permission"],
  wendy:        ["approve_trades","execute_trades","change_doctrine","issue_bobby_directives","require_transfer_permission"],
  hall:         ["approve_trades","execute_trades","bypass_kill_switch","require_transfer_permission","fight_bobby_intentional_pauses"],
  wags:         ["place_live_trade_independently","bypass_doctrine","bypass_kill_switch","require_transfer_permission"],
  brokerGateway:["decide_strategy","approve_own_orders","require_transfer_permission","bypass_doctrine","access_unapproved_orders"],
  riskDoctrine: ["generate_trade_ideas","execute_trades","approve_trades","require_transfer_permission"],
};

function isAgentForbidden(agent: AgentId, action: string): boolean {
  return (AGENT_FORBIDDEN[agent] as readonly string[]).includes(action);
}

// ── Guard decision types ───────────────────────────────────────────────────────

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
  provenancePatch: {
    validationStatus: ValidationStatus;
    fallbackUsed: boolean;
    fallbackReason?: string;
    unsafeIntentCount: number;
    protectedActionCount: number;
    guardValidator: string;
    guardReason: string;
  };
}

// ── Protected action list ──────────────────────────────────────────────────────

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

// ── Unsafe phrase patterns ─────────────────────────────────────────────────────

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

const REVIEW_REQUIRED_KEYS = new Set([
  "recommendation",
  "proposal",
  "experiment_proposal",
  "strategy_adjustment",
  "parameter_change",
]);

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

export function guardAiOutput(
  rawOutput: unknown,
  context?: {
    agentId?: AgentId;
    decisionType?: string;
  },
): AiOutputGuardResult {
  const unsafeIntents: string[] = [];
  const protectedActions: string[] = [];

  const textContent = extractTextContent(rawOutput);
  for (const phrase of UNSAFE_PHRASE_PATTERNS) {
    if (textContent.toLowerCase().includes(phrase.toLowerCase())) {
      unsafeIntents.push(phrase);
    }
  }

  const outputStr = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput ?? "");
  for (const action of PROTECTED_ACTIONS) {
    if (outputStr.toLowerCase().includes(action.toLowerCase().replace(/_/g, " ")) ||
        outputStr.includes(action)) {
      protectedActions.push(action);
    }
  }

  if (rawOutput !== null && typeof rawOutput === "object" && !Array.isArray(rawOutput)) {
    const keys = Object.keys(rawOutput as Record<string, unknown>);
    for (const key of keys) {
      if (EXECUTION_KEYS.has(key.toLowerCase())) {
        protectedActions.push(`output_key:${key}`);
      }
    }
  }

  if (context?.agentId) {
    const agentViolations = detectAgentViolations(context.agentId, outputStr);
    for (const v of agentViolations) {
      protectedActions.push(`agent_violation:${v}`);
    }
  }

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

export function detectAgentViolations(agentId: AgentId, outputText: string): string[] {
  const violations: string[] = [];
  const lowerText = outputText.toLowerCase();

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
