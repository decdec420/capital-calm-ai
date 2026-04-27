// ============================================================
// Doctrine Constants — Frontend Mirror
// ------------------------------------------------------------
// These mirror supabase/functions/_shared/doctrine.ts so the
// browser can render what the engine actually enforces without
// importing Deno-flavored code.
//
// CRITICAL: if you change a value here, change it in
// supabase/functions/_shared/doctrine.ts too — and update the
// matching test in supabase/functions/_shared/doctrine.test.ts.
// The tests will fail loudly if these drift apart.
// ============================================================

export const DOCTRINE = {
  /** Hard cap per single order, in USD. */
  MAX_ORDER_USD: 1,
  /** Hard cap on number of trades opened per UTC day. */
  MAX_TRADES_PER_DAY: 5,
  /** Hard cap on cumulative realized losses per UTC day, USD. */
  MAX_DAILY_LOSS_USD: 2,
  /** Below this equity, the kill switch fires and trading halts. */
  KILL_SWITCH_FLOOR_USD: 8,
  /** Symbols the engine will accept signals for. */
  SYMBOL_WHITELIST: ["BTC-USD", "ETH-USD", "SOL-USD"] as const,
  /** Max bid/ask spread allowed before rejecting a signal. */
  MAX_SPREAD_BPS: 30,
  /** Max age of last tick before data is considered stale. */
  STALE_DATA_SECONDS: 180,
  /** Fraction of equity risked per trade (1% = 0.01). */
  RISK_PER_TRADE_PCT: 0.01,
  /** Max cumulative daily loss as fraction of equity (3%). */
  MAX_DAILY_LOSS_PCT: 0.03,
  /** Max simultaneous correlated open positions. */
  MAX_CORRELATED_POSITIONS: 3,
} as const;
