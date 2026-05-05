// ============================================================
// Capital-Preservation Doctrine — Tiered Profiles
// ------------------------------------------------------------
// Authoritative. Browser reads from src/lib/doctrine-constants.ts
// which mirrors this file exactly. Drift requires intent — the
// matching test in doctrine.test.ts will fail loudly if values
// here diverge from the frontend mirror.
//
// Three profiles exist. Each user's `system_state.active_profile`
// chooses which one the engine enforces:
//
//   sentinel   — paper-mode safety harness (prove the edge)
//   active     — real-but-cautious once the user arms live
//   aggressive — funded + edge proven, faster + larger
//
// The principles (preserveCapitalFirst, kill-switch floor,
// symbol whitelist, liveRequiresApproval) are GLOBAL and never
// loosen between profiles. Only the *numbers* tier up.
// ============================================================

export type ProfileId = "sentinel" | "active" | "aggressive";

export interface TradingProfile {
  id: ProfileId;
  label: string;
  tagline: string;
  /** Hard cap per single order, USD. */
  maxOrderUsdHardCap: number;
  /** Hard cap on number of trades opened per UTC day. */
  maxDailyTradesHardCap: number;
  /** Hard cap on cumulative realized losses per UTC day, USD. */
  maxDailyLossUsdHardCap: number;
  /** Max simultaneous correlated open positions across whitelist. */
  maxCorrelatedPositions: number;
  /** Fraction of equity risked per trade (0.01 = 1%). */
  riskPerTradePct: number;
  /** Max cumulative daily loss as fraction of equity. */
  maxDailyLossPct: number;
  /** How often signal-engine scans the market, in seconds. */
  scanIntervalSeconds: number;
}

/** Global invariants — apply to every profile, never relax. */
export interface CapitalPreservationDoctrine {
  doctrineVersion: "v2";
  principles: {
    preserveCapitalFirst: true;
    noTradeIsValid: true;
    overtradingIsFailure: true;
    liveRequiresApproval: true;
    scalingMustBeEarned: true;
    candidateNotTrustedByDefault: true;
    learningCannotOverrideGuardrails: true;
  };
  globalRules: {
    minBalanceUsdKillSwitch: 8;
    symbolWhitelist: readonly ["BTC-USD", "ETH-USD", "SOL-USD"];
    maxSpreadBps: 30;
    staleDataSeconds: 180;
    maxCandleVolatilityPct: 0.35;
    tpLadder: {
      tp1R: 1;
      tp2R: 2;
      tp1ClosesFraction: 0.5;
      moveStopToBreakevenAtTp1: true;
    };
  };
  profiles: Record<ProfileId, TradingProfile>;
  defaultProfile: "sentinel";
}

export const CAPITAL_PRESERVATION_DOCTRINE: CapitalPreservationDoctrine = {
  doctrineVersion: "v2",
  principles: {
    preserveCapitalFirst: true,
    noTradeIsValid: true,
    overtradingIsFailure: true,
    liveRequiresApproval: true,
    scalingMustBeEarned: true,
    candidateNotTrustedByDefault: true,
    learningCannotOverrideGuardrails: true,
  },
  globalRules: {
    minBalanceUsdKillSwitch: 8,
    symbolWhitelist: ["BTC-USD", "ETH-USD", "SOL-USD"] as const,
    maxSpreadBps: 30,
    staleDataSeconds: 180,
    maxCandleVolatilityPct: 0.35,
    tpLadder: {
      tp1R: 1,
      tp2R: 2,
      tp1ClosesFraction: 0.5,
      moveStopToBreakevenAtTp1: true,
    },
  },
  profiles: {
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
      scanIntervalSeconds: 300, // 5 min
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
      scanIntervalSeconds: 120, // 2 min
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
      scanIntervalSeconds: 60, // 1 min
    },
  },
  defaultProfile: "sentinel",
};

/** Resolve a profile by id. Falls back to sentinel for any unknown value
 *  so a stale DB write can never produce an "undefined" cap. */
export function getProfile(id: string | null | undefined): TradingProfile {
  if (id === "active" || id === "aggressive" || id === "sentinel") {
    return CAPITAL_PRESERVATION_DOCTRINE.profiles[id];
  }
  return CAPITAL_PRESERVATION_DOCTRINE.profiles.sentinel;
}

export const ALL_PROFILE_IDS: readonly ProfileId[] = [
  "sentinel",
  "active",
  "aggressive",
] as const;

// ── Convenience aliases ─────────────────────────────────────────
// Legacy callers still import these; they resolve to the SENTINEL
// profile so existing behaviour is unchanged unless the engine
// explicitly switches profiles per-user. Per-user code should use
// getProfile(state.active_profile).<field> instead.
const SENTINEL = CAPITAL_PRESERVATION_DOCTRINE.profiles.sentinel;
export const MAX_ORDER_USD = SENTINEL.maxOrderUsdHardCap;
export const MAX_TRADES_PER_DAY = SENTINEL.maxDailyTradesHardCap;
export const MAX_DAILY_LOSS_USD = SENTINEL.maxDailyLossUsdHardCap;
export const RISK_PER_TRADE_PCT = SENTINEL.riskPerTradePct;
export const MAX_DAILY_LOSS_PCT = SENTINEL.maxDailyLossPct;
export const MAX_CORRELATED_POSITIONS = SENTINEL.maxCorrelatedPositions;

export const KILL_SWITCH_FLOOR_USD =
  CAPITAL_PRESERVATION_DOCTRINE.globalRules.minBalanceUsdKillSwitch;
export const SYMBOL_WHITELIST =
  CAPITAL_PRESERVATION_DOCTRINE.globalRules.symbolWhitelist;
export const MAX_SPREAD_BPS =
  CAPITAL_PRESERVATION_DOCTRINE.globalRules.maxSpreadBps;
export const STALE_DATA_SECONDS =
  CAPITAL_PRESERVATION_DOCTRINE.globalRules.staleDataSeconds;

// Fail-loud invariant check. Called at module load in every edge function
// so an accidental constant change explodes immediately, not silently in prod.
export function validateDoctrineInvariants(): void {
  const p = CAPITAL_PRESERVATION_DOCTRINE.profiles;

  // Tier ordering must hold — sentinel is the floor of conservatism.
  if (p.sentinel.maxOrderUsdHardCap > p.active.maxOrderUsdHardCap) {
    throw new Error("Doctrine invariant: sentinel order cap must be <= active.");
  }
  if (p.active.maxOrderUsdHardCap > p.aggressive.maxOrderUsdHardCap) {
    throw new Error("Doctrine invariant: active order cap must be <= aggressive.");
  }
  if (p.sentinel.maxDailyTradesHardCap > p.active.maxDailyTradesHardCap) {
    throw new Error("Doctrine invariant: sentinel trade cap must be <= active.");
  }

  // Sentinel ceiling — original safety contract is preserved.
  if (p.sentinel.maxOrderUsdHardCap > 1) {
    throw new Error("Doctrine invariant: sentinel.maxOrderUsdHardCap must be <= $1.");
  }
  if (p.sentinel.maxDailyTradesHardCap > 5) {
    throw new Error("Doctrine invariant: sentinel.maxDailyTradesHardCap must be <= 5.");
  }
  if (p.sentinel.maxDailyLossUsdHardCap > 2) {
    throw new Error("Doctrine invariant: sentinel.maxDailyLossUsdHardCap must be <= $2.");
  }

  // Aggressive ceiling — even the loosest profile has a hard wall.
  if (p.aggressive.maxOrderUsdHardCap > 100) {
    throw new Error("Doctrine invariant: aggressive.maxOrderUsdHardCap must be <= $100.");
  }
  if (p.aggressive.maxDailyTradesHardCap > 50) {
    throw new Error("Doctrine invariant: aggressive.maxDailyTradesHardCap must be <= 50.");
  }
  if (p.aggressive.maxDailyLossUsdHardCap > 100) {
    throw new Error("Doctrine invariant: aggressive.maxDailyLossUsdHardCap must be <= $100.");
  }

  // Global rules — never relax.
  if (CAPITAL_PRESERVATION_DOCTRINE.globalRules.minBalanceUsdKillSwitch < 8) {
    throw new Error("Doctrine invariant: minBalanceUsdKillSwitch must be >= $8.");
  }
  if (!CAPITAL_PRESERVATION_DOCTRINE.principles.liveRequiresApproval) {
    throw new Error("Doctrine invariant: liveRequiresApproval must remain true.");
  }
  if (!CAPITAL_PRESERVATION_DOCTRINE.principles.noTradeIsValid) {
    throw new Error("Doctrine invariant: noTradeIsValid must remain true.");
  }
}

// Symbol whitelist guard — used by risk gate and clampSize.
export function isWhitelistedSymbol(sym: string): boolean {
  return (SYMBOL_WHITELIST as readonly string[]).includes(sym);
}
