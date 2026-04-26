// ============================================================
// strategy-naming — turn technical strategy ids into something
// a human can read at a glance.
// ============================================================
//
// Two helpers:
//   - displayNameFor(strategy)       → "Steady Trender" / fallback to name
//   - autoSummaryFromVersion(version) → "Wider stops experiment" or null
//
// We keep the technical name/version intact for the engine and the
// "Changes vs live" diff. These are pure presentational.

import type { StrategyVersion } from "./domain-types";

/** Fallback nickname when the strategy has no explicit display_name. */
const NAME_DICT: Record<string, string> = {
  "trend-rev": "Steady Trender",
  "mean-rev": "Mean Reverter",
  "breakout": "Breakout Hunter",
  "scalp": "Quick Scalper",
};

export function displayNameFor(s: Pick<StrategyVersion, "name" | "displayName">): string {
  if (s.displayName && s.displayName.trim()) return s.displayName.trim();
  const key = s.name.toLowerCase();
  return NAME_DICT[key] ?? toTitleCase(s.name);
}

function toTitleCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Map a parameter key + direction to a friendly experiment phrase. */
const PARAM_PHRASES: Record<string, { up: string; down: string }> = {
  stop_atr_mult: { up: "Wider stops experiment", down: "Tighter stops experiment" },
  rsi_period: { up: "Slower RSI experiment", down: "Faster RSI experiment" },
  ema_fast: { up: "Slower fast-EMA experiment", down: "Faster fast-EMA experiment" },
  ema_slow: { up: "Slower slow-EMA experiment", down: "Faster slow-EMA experiment" },
  max_order_pct: { up: "Bigger size experiment", down: "Smaller size experiment" },
};

/** Try to read "+stop_atr_mult=2" out of a version string and produce a phrase. */
export function autoSummaryFromVersion(version: string, baseValue?: unknown): string | null {
  const m = version.match(/\+([^=]+)=(.+)$/);
  if (!m) return null;
  const key = m[1];
  const newVal = m[2];
  const phrases = PARAM_PHRASES[key];
  if (!phrases) {
    return `${prettyParam(key)} tweak`;
  }
  // Decide direction if we know the prior value.
  if (baseValue !== undefined && baseValue !== null) {
    const a = Number(baseValue);
    const b = Number(newVal);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return b > a ? phrases.up : b < a ? phrases.down : phrases.up;
    }
  }
  return phrases.up;
}

function prettyParam(key: string): string {
  return key.replace(/_/g, " ");
}
