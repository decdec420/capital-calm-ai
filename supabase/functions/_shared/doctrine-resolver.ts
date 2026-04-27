// ============================================================
// Doctrine Resolver — Per-User Effective Caps
// ------------------------------------------------------------
// Single source of truth for "what doctrine numbers apply to
// THIS user RIGHT NOW?" Every edge function (signal-engine,
// jessica, katrina, copilot-chat, post-trade-learn) and the
// browser (via the mirror at src/lib/doctrine-resolver.ts) MUST
// route through resolveDoctrine() instead of reading hardcoded
// constants from doctrine.ts.
//
// Inputs:
//   - settings:        row from public.doctrine_settings
//   - currentEquityUsd current equity (live, mark-to-market)
//
// Output: ResolvedDoctrine — every cap a USD number, every floor
// a USD number, ready to feed risk gates and sizing.
// ============================================================

export interface DoctrineSettingsRow {
  starting_equity_usd: number | null;
  max_order_pct: number;
  max_order_abs_cap: number;
  max_order_abs_floor: number;
  daily_loss_pct: number;
  max_trades_per_day: number;
  floor_pct: number;
  floor_abs_min: number;
  consecutive_loss_limit: number;
  loss_cooldown_minutes: number;
  risk_per_trade_pct: number;
  scan_interval_seconds: number;
  max_correlated_positions: number;
}

export interface ResolvedDoctrine {
  /** The equity used to derive these numbers. */
  basisEquityUsd: number;
  /** Whether starting_equity_usd was set or we fell back. */
  startingEquityKnown: boolean;
  /** Per-order USD cap (equity * pct, clamped to [absFloor, absCap]). */
  maxOrderUsd: number;
  /** Daily realised-loss USD cap (equity * pct). */
  dailyLossUsd: number;
  /** Daily loss as a fraction of equity. */
  dailyLossPct: number;
  /** Max trades opened per UTC day. */
  maxTradesPerDay: number;
  /** Kill-switch floor in USD: max(starting * floor_pct, floor_abs_min). */
  killSwitchFloorUsd: number;
  /** Floor as a percent of starting equity. */
  floorPct: number;
  /** Per-trade fractional risk used by sizer. */
  riskPerTradePct: number;
  /** Loss-streak cooldown thresholds. */
  consecutiveLossLimit: number;
  lossCooldownMinutes: number;
  /** Scan interval seconds for signal-engine. */
  scanIntervalSeconds: number;
  /** Cap on simultaneous correlated open positions. */
  maxCorrelatedPositions: number;
}

/**
 * Defaults used when a user's doctrine_settings row is missing.
 * Mirrors the sentinel preset.
 */
export const DOCTRINE_FALLBACK: DoctrineSettingsRow = {
  starting_equity_usd: null,
  max_order_pct: 0.001,
  max_order_abs_cap: 1,
  max_order_abs_floor: 0.25,
  daily_loss_pct: 0.003,
  max_trades_per_day: 5,
  floor_pct: 0.80,
  floor_abs_min: 5,
  consecutive_loss_limit: 2,
  loss_cooldown_minutes: 30,
  risk_per_trade_pct: 0.01,
  scan_interval_seconds: 300,
  max_correlated_positions: 3,
};

export function resolveDoctrine(
  settings: DoctrineSettingsRow | null | undefined,
  currentEquityUsd: number,
): ResolvedDoctrine {
  const s = settings ?? DOCTRINE_FALLBACK;

  // basisEquity for sizing = current equity (compounding).
  // Floor 0 / non-finite to a safe positive so we never produce NaN caps.
  const equity = Number.isFinite(currentEquityUsd) && currentEquityUsd > 0
    ? currentEquityUsd
    : 0;

  // starting_equity is the basis for the kill-switch floor.
  // If unknown, fall back to current equity (or $10) so we never produce a $0 floor.
  const startingEquityKnown = s.starting_equity_usd !== null && s.starting_equity_usd !== undefined && s.starting_equity_usd > 0;
  const startingEquity = startingEquityKnown
    ? (s.starting_equity_usd as number)
    : Math.max(equity, 10);

  // Per-order USD cap: percentage of current equity, bounded.
  const rawOrderUsd = equity * (s.max_order_pct ?? 0);
  const maxOrderUsd = clamp(
    rawOrderUsd,
    s.max_order_abs_floor ?? 0.25,
    s.max_order_abs_cap ?? 1,
  );

  // Daily loss cap: percentage of current equity (no abs cap — the pct IS the cap).
  const dailyLossUsd = Math.max(0, equity * (s.daily_loss_pct ?? 0));

  // Kill-switch floor: starting equity * floor_pct, never below floor_abs_min.
  const killSwitchFloorUsd = Math.max(
    startingEquity * (s.floor_pct ?? 0.80),
    s.floor_abs_min ?? 5,
  );

  return {
    basisEquityUsd: equity,
    startingEquityKnown,
    maxOrderUsd,
    dailyLossUsd,
    dailyLossPct: s.daily_loss_pct ?? 0,
    maxTradesPerDay: s.max_trades_per_day ?? 5,
    killSwitchFloorUsd,
    floorPct: s.floor_pct ?? 0.80,
    riskPerTradePct: s.risk_per_trade_pct ?? 0.01,
    consecutiveLossLimit: s.consecutive_loss_limit ?? 2,
    lossCooldownMinutes: s.loss_cooldown_minutes ?? 30,
    scanIntervalSeconds: s.scan_interval_seconds ?? 300,
    maxCorrelatedPositions: s.max_correlated_positions ?? 3,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}

// ── Tighten / loosen classifier ─────────────────────────────────
// Used by update-doctrine to decide instant-apply vs 24h cooldown.

export type DoctrineField =
  | "max_order_pct"
  | "max_order_abs_cap"
  | "daily_loss_pct"
  | "max_trades_per_day"
  | "floor_pct"
  | "risk_per_trade_pct"
  | "consecutive_loss_limit"
  | "loss_cooldown_minutes"
  | "scan_interval_seconds"
  | "max_correlated_positions";

/**
 * Returns true if changing `field` from `from` to `to` LOOSENS risk
 * (and therefore must wait the 24h tilt-protection cooldown).
 * Tightening returns false (applies instantly).
 */
export function isLoosening(field: DoctrineField, from: number, to: number): boolean {
  if (from === to) return false;
  switch (field) {
    // ↑ = more risk
    case "max_order_pct":
    case "max_order_abs_cap":
    case "daily_loss_pct":
    case "max_trades_per_day":
    case "risk_per_trade_pct":
    case "consecutive_loss_limit":
    case "max_correlated_positions":
      return to > from;
    // ↓ = more risk (lower floor / shorter cooldown / faster scan)
    case "floor_pct":
    case "loss_cooldown_minutes":
    case "scan_interval_seconds":
      return to < from;
  }
}

export const DOCTRINE_FIELD_LABELS: Record<DoctrineField, string> = {
  max_order_pct: "Max order (% of equity)",
  max_order_abs_cap: "Max order absolute cap (USD)",
  daily_loss_pct: "Daily loss cap (% of equity)",
  max_trades_per_day: "Max trades per day",
  floor_pct: "Kill-switch floor (% of starting equity)",
  risk_per_trade_pct: "Risk per trade (% of equity)",
  consecutive_loss_limit: "Consecutive loss limit",
  loss_cooldown_minutes: "Loss cooldown (minutes)",
  scan_interval_seconds: "Scan interval (seconds)",
  max_correlated_positions: "Max correlated positions",
};
