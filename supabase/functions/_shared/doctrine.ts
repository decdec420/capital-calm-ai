// ============================================================
// Capital-Preservation Doctrine
// ------------------------------------------------------------
// Authoritative. Browser reads from this; never forks.
// Ported from decdec420/Trader → src/doctrine/capital-preservation.ts.
// These are the hard caps that gate every trading decision.
// Changing a constant here requires a paired test update in
// doctrine.test.ts (that's the point — drift requires intent).
// ============================================================

export interface CapitalPreservationDoctrine {
  doctrineVersion: "v1";
  principles: {
    preserveCapitalFirst: true;
    noTradeIsValid: true;
    overtradingIsFailure: true;
    liveRequiresApproval: true;
    scalingMustBeEarned: true;
    candidateNotTrustedByDefault: true;
    learningCannotOverrideGuardrails: true;
  };
  hardRules: {
    maxOrderUsdHardCap: 1;
    maxDailyTradesHardCap: 5;
    maxDailyLossUsdHardCap: 1;
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
    /** Percentage of equity to risk per trade (1% = 0.01). */
    riskPerTradePct: 0.01;
    /** Maximum daily loss as % of equity (3% = 0.03). */
    maxDailyLossPct: 0.03;
    /** Max number of correlated open positions across whitelisted symbols. */
    maxCorrelatedPositions: 3;
  };
}

export const CAPITAL_PRESERVATION_DOCTRINE: CapitalPreservationDoctrine = {
  doctrineVersion: "v1",
  principles: {
    preserveCapitalFirst: true,
    noTradeIsValid: true,
    overtradingIsFailure: true,
    liveRequiresApproval: true,
    scalingMustBeEarned: true,
    candidateNotTrustedByDefault: true,
    learningCannotOverrideGuardrails: true,
  },
  hardRules: {
    maxOrderUsdHardCap: 1,
    maxDailyTradesHardCap: 5,
    maxDailyLossUsdHardCap: 1,
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
    riskPerTradePct: 0.01,
    maxDailyLossPct: 0.03,
    maxCorrelatedPositions: 3,
  },
};

// Convenience aliases (used throughout _shared)
export const MAX_ORDER_USD = CAPITAL_PRESERVATION_DOCTRINE.hardRules.maxOrderUsdHardCap;
export const MAX_TRADES_PER_DAY = CAPITAL_PRESERVATION_DOCTRINE.hardRules.maxDailyTradesHardCap;
export const MAX_DAILY_LOSS_USD = CAPITAL_PRESERVATION_DOCTRINE.hardRules.maxDailyLossUsdHardCap;
export const KILL_SWITCH_FLOOR_USD = CAPITAL_PRESERVATION_DOCTRINE.hardRules.minBalanceUsdKillSwitch;
export const SYMBOL_WHITELIST = CAPITAL_PRESERVATION_DOCTRINE.hardRules.symbolWhitelist;
export const MAX_SPREAD_BPS = CAPITAL_PRESERVATION_DOCTRINE.hardRules.maxSpreadBps;
export const STALE_DATA_SECONDS = CAPITAL_PRESERVATION_DOCTRINE.hardRules.staleDataSeconds;
export const RISK_PER_TRADE_PCT = CAPITAL_PRESERVATION_DOCTRINE.hardRules.riskPerTradePct;
export const MAX_DAILY_LOSS_PCT = CAPITAL_PRESERVATION_DOCTRINE.hardRules.maxDailyLossPct;
export const MAX_CORRELATED_POSITIONS = CAPITAL_PRESERVATION_DOCTRINE.hardRules.maxCorrelatedPositions;

// Fail-loud invariant check. Called at module load in every edge function
// so an accidental constant change explodes immediately, not silently in prod.
export function validateDoctrineInvariants(): void {
  if (CAPITAL_PRESERVATION_DOCTRINE.hardRules.maxOrderUsdHardCap > 1) {
    throw new Error("Doctrine invariant failed: maxOrderUsdHardCap must be <= $1.");
  }
  if (CAPITAL_PRESERVATION_DOCTRINE.hardRules.maxDailyTradesHardCap > 5) {
    throw new Error("Doctrine invariant failed: maxDailyTradesHardCap must be <= 5.");
  }
  if (CAPITAL_PRESERVATION_DOCTRINE.hardRules.maxDailyLossUsdHardCap > 2) {
    throw new Error("Doctrine invariant failed: maxDailyLossUsdHardCap must be <= $2.");
  }
  if (CAPITAL_PRESERVATION_DOCTRINE.hardRules.minBalanceUsdKillSwitch < 8) {
    throw new Error("Doctrine invariant failed: minBalanceUsdKillSwitch must be >= $8.");
  }
  if (!CAPITAL_PRESERVATION_DOCTRINE.principles.liveRequiresApproval) {
    throw new Error("Doctrine invariant failed: liveRequiresApproval must remain true.");
  }
  if (!CAPITAL_PRESERVATION_DOCTRINE.principles.noTradeIsValid) {
    throw new Error("Doctrine invariant failed: noTradeIsValid must remain true.");
  }
}

// Symbol whitelist guard — used by risk gate and clampSize.
export function isWhitelistedSymbol(sym: string): boolean {
  return (SYMBOL_WHITELIST as readonly string[]).includes(sym);
}
