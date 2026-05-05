// ============================================================
// Doctrine Constants — Frontend Mirror
// ------------------------------------------------------------
// Mirrors supabase/functions/_shared/doctrine.ts so the browser
// can render what the engine actually enforces without importing
// Deno-flavoured code.
//
// CRITICAL: if you change a number here, change it in
// supabase/functions/_shared/doctrine.ts too — and update the
// matching test in supabase/functions/_shared/doctrine.test.ts.
// The tests will fail loudly if these drift apart.
// ============================================================

export type ProfileId = "sentinel" | "active" | "aggressive";

export interface TradingProfile {
  id: ProfileId;
  label: string;
  tagline: string;
  maxOrderUsdHardCap: number;
  maxDailyTradesHardCap: number;
  maxDailyLossUsdHardCap: number;
  maxCorrelatedPositions: number;
  riskPerTradePct: number;
  maxDailyLossPct: number;
  scanIntervalSeconds: number;
}

export const TRADING_PROFILES: Record<ProfileId, TradingProfile> = {
  sentinel: {
    id: "sentinel",
    label: "Sentinel",
    tagline: "Paper-mode safety harness. Prove the edge.",
    maxOrderUsdHardCap: 1,
    maxDailyTradesHardCap: 5,
    maxDailyLossUsdHardCap: 2,
    maxCorrelatedPositions: 3,
    riskPerTradePct: 0.01,
    maxDailyLossPct: 0.03,
    scanIntervalSeconds: 300,
  },
  active: {
    id: "active",
    label: "Active",
    tagline: "Real-but-cautious. More chances, modest size.",
    maxOrderUsdHardCap: 15,
    maxDailyTradesHardCap: 15,
    maxDailyLossUsdHardCap: 10,
    maxCorrelatedPositions: 5,
    riskPerTradePct: 0.015,
    maxDailyLossPct: 0.05,
    scanIntervalSeconds: 120,
  },
  aggressive: {
    id: "aggressive",
    label: "Aggressive",
    tagline: "Funded + edge proven. Faster, larger, hungrier.",
    maxOrderUsdHardCap: 50,
    maxDailyTradesHardCap: 30,
    maxDailyLossUsdHardCap: 50,
    maxCorrelatedPositions: 6,
    riskPerTradePct: 0.02,
    maxDailyLossPct: 0.08,
    scanIntervalSeconds: 60,
  },
};

export const ALL_PROFILE_IDS: readonly ProfileId[] = [
  "sentinel",
  "active",
  "aggressive",
] as const;

export const DEFAULT_PROFILE_ID: ProfileId = "sentinel";

export function getProfile(id: string | null | undefined): TradingProfile {
  if (id === "active" || id === "aggressive" || id === "sentinel") {
    return TRADING_PROFILES[id];
  }
  return TRADING_PROFILES[DEFAULT_PROFILE_ID];
}

// ── Global rules (apply to every profile, never relax) ──────────
export const GLOBAL_RULES = {
  KILL_SWITCH_FLOOR_USD: 8,
  SYMBOL_WHITELIST: ["BTC-USD", "ETH-USD", "SOL-USD"] as const,
  MAX_SPREAD_BPS: 30,
  STALE_DATA_SECONDS: 180,
} as const;

// ── Legacy DOCTRINE export ──────────────────────────────────────
// Existing components that read DOCTRINE.MAX_* see the **Sentinel**
// numbers by default. To render the user's *active* profile, use
// `getProfile(activeProfileId)` and read its fields.
const SENTINEL = TRADING_PROFILES.sentinel;
export const DOCTRINE = {
  MAX_ORDER_USD: SENTINEL.maxOrderUsdHardCap,
  MAX_TRADES_PER_DAY: SENTINEL.maxDailyTradesHardCap,
  MAX_DAILY_LOSS_USD: SENTINEL.maxDailyLossUsdHardCap,
  KILL_SWITCH_FLOOR_USD: GLOBAL_RULES.KILL_SWITCH_FLOOR_USD,
  SYMBOL_WHITELIST: GLOBAL_RULES.SYMBOL_WHITELIST,
  MAX_SPREAD_BPS: GLOBAL_RULES.MAX_SPREAD_BPS,
  STALE_DATA_SECONDS: GLOBAL_RULES.STALE_DATA_SECONDS,
  RISK_PER_TRADE_PCT: SENTINEL.riskPerTradePct,
  MAX_DAILY_LOSS_PCT: SENTINEL.maxDailyLossPct,
  MAX_CORRELATED_POSITIONS: SENTINEL.maxCorrelatedPositions,
} as const;
