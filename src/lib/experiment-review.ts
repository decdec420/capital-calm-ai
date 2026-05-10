// ============================================================
// Experiment Review — PR #42
// Pure validation functions for promoting strategy_learning
// experiment proposals from needs_review → queued.
//
// Safety invariants (enforced here + in the hook):
//   - Promotion only touches before_value, after_value, status, notes.
//   - source and source_recommendation_id are NEVER changed.
//   - proposed_by is NEVER changed.
//   - Promotion NEVER mutates strategies, doctrine, risk gates, or signals.
//   - Promotion NEVER creates trades or calls any broker endpoint.
//   - Only needs_review experiments from source=strategy_learning are eligible.
//   - strategy_fit parameter family is UNSUPPORTED — blocks promotion.
//   - All numeric parameter families require values in [0, 1].
//   - before_value must differ from after_value.
// ============================================================

// ─── Parameter families ───────────────────────────────────────────────────────

export type NumericParameterFamily =
  | "confidence_threshold"
  | "setup_score_threshold"
  | "coach_penalty"
  | "risk_manager_veto";

export type UnsupportedParameterFamily = "strategy_fit";

export type KnownParameterFamily = NumericParameterFamily | UnsupportedParameterFamily;

/**
 * Parameter families that require numeric before/after values in [0, 1].
 * Mirrors the families produced by reasonCodeToParameterFamily in strategy-learning.ts
 * for the non-default cases.
 */
export const NUMERIC_PARAMETER_FAMILIES = new Set<string>([
  "confidence_threshold",
  "setup_score_threshold",
  "coach_penalty",
  "risk_manager_veto",
]);

/**
 * Parameter families that cannot be promoted automatically.
 * strategy_fit is the catch-all for unknown/complex reason codes.
 * It requires a human to open a manual experiment with specific numeric values.
 */
export const UNSUPPORTED_PARAMETER_FAMILIES = new Set<string>([
  "strategy_fit",
]);

/** Valid numeric range for threshold/penalty family parameters. */
export const THRESHOLD_RANGE = { min: 0, max: 1 } as const;

// ─── Validation input ─────────────────────────────────────────────────────────

export interface PromoteToQueuedInput {
  id: string;
  status: string;
  source: string | null | undefined;
  parameter: string;
  beforeValue: string;
  afterValue: string;
}

// ─── Validation result ────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ─── Core validator ───────────────────────────────────────────────────────────

/**
 * Validate all preconditions for promoting a strategy_learning experiment
 * proposal from needs_review → queued.
 *
 * Returns { valid: true, errors: [] } on success.
 * Returns { valid: false, errors: [...] } with human-readable messages on failure.
 *
 * Pure function — no DB writes, no side effects.
 */
export function validatePromoteToQueued(input: PromoteToQueuedInput): ValidationResult {
  const errors: string[] = [];

  // 1. Status guard: only needs_review → queued is allowed
  if (input.status !== "needs_review") {
    errors.push(blockedTransitionMessage(input.status));
    return { valid: false, errors };
  }

  // 2. Source guard: only strategy_learning proposals go through this path
  if (input.source !== "strategy_learning") {
    errors.push(
      "Cannot promote: this experiment was not created from a strategy learning recommendation. " +
      "Use the standard experiment queue for manually created experiments.",
    );
    return { valid: false, errors };
  }

  // 3. Empty value guards
  if (!input.beforeValue.trim()) {
    errors.push("Before value is required.");
  }
  if (!input.afterValue.trim()) {
    errors.push("After value is required.");
  }

  if (errors.length > 0) return { valid: false, errors };

  const param = input.parameter;

  // 4. Unsupported parameter family (strategy_fit + unknown)
  if (UNSUPPORTED_PARAMETER_FAMILIES.has(param)) {
    errors.push(
      `Parameter family '${param}' requires manual review and cannot be promoted automatically. ` +
      "Open a manual experiment with specific numeric parameters instead.",
    );
    return { valid: false, errors };
  }

  if (!NUMERIC_PARAMETER_FAMILIES.has(param)) {
    errors.push(
      `Parameter family '${param}' is not recognized. Cannot promote automatically — manual review required.`,
    );
    return { valid: false, errors };
  }

  // 5. Numeric parsing
  const before = Number(input.beforeValue.trim());
  const after = Number(input.afterValue.trim());

  if (!Number.isFinite(before)) {
    errors.push(`Before value "${input.beforeValue}" is not a valid number for parameter '${param}'.`);
  }
  if (!Number.isFinite(after)) {
    errors.push(`After value "${input.afterValue}" is not a valid number for parameter '${param}'.`);
  }

  if (errors.length > 0) return { valid: false, errors };

  // 6. Range validation [0, 1] for all numeric threshold/penalty parameters
  if (before < THRESHOLD_RANGE.min || before > THRESHOLD_RANGE.max) {
    errors.push(
      `Before value ${before} is out of range [0, 1] for parameter '${param}'. ` +
      "Threshold and penalty values must be between 0 and 1.",
    );
  }
  if (after < THRESHOLD_RANGE.min || after > THRESHOLD_RANGE.max) {
    errors.push(
      `After value ${after} is out of range [0, 1] for parameter '${param}'. ` +
      "Threshold and penalty values must be between 0 and 1.",
    );
  }

  if (errors.length > 0) return { valid: false, errors };

  // 7. Inequality: after must differ from before
  if (before === after) {
    errors.push(
      `After value (${after}) must differ from before value (${before}). ` +
      "A no-op experiment cannot be queued.",
    );
  }

  return { valid: errors.length === 0, errors };
}

// ─── State transition message ─────────────────────────────────────────────────

/**
 * Returns a user-visible message explaining why a non-needs_review status
 * cannot be promoted to queued.
 */
export function blockedTransitionMessage(status: string): string {
  switch (status) {
    case "queued":
      return "This experiment is already queued.";
    case "running":
      return "This experiment is currently running and cannot be re-queued.";
    case "accepted":
      return "This experiment has already been accepted. Accepted experiments cannot be re-queued.";
    case "rejected":
      return "This experiment was rejected. Rejected experiments cannot be re-queued.";
    default:
      return `Cannot queue experiment with status '${status}'.`;
  }
}

// ─── Delta helper ─────────────────────────────────────────────────────────────

/**
 * Compute a human-readable delta string for numeric parameter families.
 * Returns empty string for unsupported/non-numeric parameters.
 */
export function computeDelta(parameter: string, beforeValue: string, afterValue: string): string {
  if (!NUMERIC_PARAMETER_FAMILIES.has(parameter)) return "";
  const before = Number(beforeValue.trim());
  const after = Number(afterValue.trim());
  if (!Number.isFinite(before) || !Number.isFinite(after)) return "";
  const diff = after - before;
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${diff.toFixed(4)}`;
}

// ─── Safety copy ──────────────────────────────────────────────────────────────

/**
 * Standard safety disclaimer shown in the promote-to-queued UI.
 * Must be visible before any promote action is allowed.
 */
export const PROMOTE_SAFETY_COPY =
  "Promoting queues a research backtest only. " +
  "It does not change strategy behavior, doctrine, risk gates, signals, or trades.";

/**
 * Copy shown when a proposal is ineligible for promotion.
 */
export const INELIGIBLE_SAFETY_COPY =
  "This proposal cannot be queued because it lacks valid numeric test values " +
  "or comes from a protected safety-block recommendation.";
