// ============================================================
// Doctrine Resolver — Browser Mirror
// ------------------------------------------------------------
// MUST stay in lock-step with supabase/functions/_shared/doctrine-resolver.ts
// Any change to math here must be made there too. Tests in
// src/test/doctrine.test.ts will fail loudly on drift.
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
  basisEquityUsd: number;
  startingEquityKnown: boolean;
  maxOrderUsd: number;
  dailyLossUsd: number;
  dailyLossPct: number;
  maxTradesPerDay: number;
  killSwitchFloorUsd: number;
  floorPct: number;
  riskPerTradePct: number;
  consecutiveLossLimit: number;
  lossCooldownMinutes: number;
  scanIntervalSeconds: number;
  maxCorrelatedPositions: number;
}

export const DOCTRINE_FALLBACK: DoctrineSettingsRow = {
  starting_equity_usd: null,
  max_order_pct: 0.001,
  max_order_abs_cap: 1,
  max_order_abs_floor: 0.25,
  daily_loss_pct: 0.003,
  max_trades_per_day: 5,
  floor_pct: 0.80,
  floor_abs_min: 5,
  consecutive_loss_limit: 4,
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
  const equity = Number.isFinite(currentEquityUsd) && currentEquityUsd > 0 ? currentEquityUsd : 0;

  const startingEquityKnown = s.starting_equity_usd !== null && s.starting_equity_usd !== undefined && s.starting_equity_usd > 0;
  const startingEquity = startingEquityKnown ? (s.starting_equity_usd as number) : Math.max(equity, 10);

  const rawOrderUsd = equity * (s.max_order_pct ?? 0);
  const maxOrderUsd = clamp(rawOrderUsd, s.max_order_abs_floor ?? 0.25, s.max_order_abs_cap ?? 1);

  const dailyLossUsd = Math.max(0, equity * (s.daily_loss_pct ?? 0));
  const killSwitchFloorUsd = Math.max(startingEquity * (s.floor_pct ?? 0.80), s.floor_abs_min ?? 5);

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
    consecutiveLossLimit: s.consecutive_loss_limit ?? 4,
    lossCooldownMinutes: s.loss_cooldown_minutes ?? 30,
    scanIntervalSeconds: s.scan_interval_seconds ?? 300,
    maxCorrelatedPositions: s.max_correlated_positions ?? 3,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}

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

export function isLoosening(field: DoctrineField, from: number, to: number): boolean {
  if (from === to) return false;
  switch (field) {
    case "max_order_pct":
    case "max_order_abs_cap":
    case "daily_loss_pct":
    case "max_trades_per_day":
    case "risk_per_trade_pct":
    case "consecutive_loss_limit":
    case "max_correlated_positions":
      return to > from;
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

// ── Profile presets ───────────────────────────────────────────
export const SENTINEL_PRESET = {
  max_order_pct: 0.001, max_order_abs_cap: 1,  daily_loss_pct: 0.003, floor_pct: 0.80, max_trades_per_day: 5,  risk_per_trade_pct: 0.01,  scan_interval_seconds: 300, max_correlated_positions: 3,
};
export const ACTIVE_PRESET = {
  max_order_pct: 0.005, max_order_abs_cap: 5,  daily_loss_pct: 0.01,  floor_pct: 0.75, max_trades_per_day: 15, risk_per_trade_pct: 0.015, scan_interval_seconds: 120, max_correlated_positions: 3,
};
export const AGGRESSIVE_PRESET = {
  max_order_pct: 0.025, max_order_abs_cap: 25, daily_loss_pct: 0.03,  floor_pct: 0.60, max_trades_per_day: 30, risk_per_trade_pct: 0.02,  scan_interval_seconds: 60,  max_correlated_positions: 4,
};
export type ProfilePresetId = "sentinel" | "active" | "aggressive";
export const PROFILE_PRESETS: Record<ProfilePresetId, typeof SENTINEL_PRESET> = {
  sentinel: SENTINEL_PRESET, active: ACTIVE_PRESET, aggressive: AGGRESSIVE_PRESET,
};

// ── Per-symbol overrides + overlay (Diamond-Tier mirror) ──────

export interface DoctrineSymbolOverrideRow {
  symbol: string;
  enabled: boolean;
  max_order_pct: number | null;
  risk_per_trade_pct: number | null;
  daily_loss_pct: number | null;
  max_trades_per_day: number | null;
}

export interface DoctrineOverlayInput {
  sizeMult: number;
  tradesMult: number;
  riskMult: number;
  dailyLossMult: number;
  blockNewEntries: boolean;
}

export interface ResolvedDoctrineForSymbol extends ResolvedDoctrine {
  symbol: string;
  overrideApplied: boolean;
  overlayApplied: boolean;
  blockNewEntries: boolean;
}

export function resolveDoctrineForSymbol(
  settings: DoctrineSettingsRow | null | undefined,
  override: DoctrineSymbolOverrideRow | null | undefined,
  overlay: DoctrineOverlayInput | null | undefined,
  symbol: string,
  currentEquityUsd: number,
): ResolvedDoctrineForSymbol {
  const base = resolveDoctrine(settings, currentEquityUsd);
  const equity = base.basisEquityUsd;

  let maxOrderUsd = base.maxOrderUsd;
  let dailyLossUsd = base.dailyLossUsd;
  let dailyLossPct = base.dailyLossPct;
  let maxTradesPerDay = base.maxTradesPerDay;
  let riskPerTradePct = base.riskPerTradePct;

  const overrideApplied = !!(override && override.enabled);
  if (overrideApplied) {
    if (override!.max_order_pct != null && equity > 0) {
      maxOrderUsd = Math.min(maxOrderUsd, equity * override!.max_order_pct);
    }
    if (override!.daily_loss_pct != null) {
      dailyLossPct = Math.min(dailyLossPct, override!.daily_loss_pct);
      if (equity > 0) dailyLossUsd = Math.min(dailyLossUsd, equity * override!.daily_loss_pct);
    }
    if (override!.max_trades_per_day != null) {
      maxTradesPerDay = Math.min(maxTradesPerDay, override!.max_trades_per_day);
    }
    if (override!.risk_per_trade_pct != null) {
      riskPerTradePct = Math.min(riskPerTradePct, override!.risk_per_trade_pct);
    }
  }

  const overlayApplied = !!overlay && (
    overlay.sizeMult < 1 || overlay.tradesMult < 1 || overlay.riskMult < 1 || overlay.dailyLossMult < 1 || overlay.blockNewEntries
  );
  if (overlay) {
    maxOrderUsd     *= Math.max(0, Math.min(1, overlay.sizeMult));
    maxTradesPerDay  = Math.floor(maxTradesPerDay * Math.max(0, Math.min(1, overlay.tradesMult)));
    riskPerTradePct *= Math.max(0, Math.min(1, overlay.riskMult));
    dailyLossUsd    *= Math.max(0, Math.min(1, overlay.dailyLossMult));
    dailyLossPct    *= Math.max(0, Math.min(1, overlay.dailyLossMult));
  }

  return {
    ...base,
    symbol,
    maxOrderUsd,
    dailyLossUsd,
    dailyLossPct,
    maxTradesPerDay,
    riskPerTradePct,
    overrideApplied,
    overlayApplied,
    blockNewEntries: overlay?.blockNewEntries ?? false,
  };
}
