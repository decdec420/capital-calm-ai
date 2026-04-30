// Coinbase market-data and broker-health capability model.
// Central source used by orchestration paths so paper mode can use
// read-only/public market data without implying live broker readiness.

export type CandleInterval =
  | "1m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "6h"
  | "1d";

export type CandleSourceCapability = {
  interval: CandleInterval;
  exchangePublicSupported: boolean;
  advancedTradeSupported: boolean;
  canDeriveFrom?: CandleInterval;
};

export const COINBASE_INTERVAL_CAPABILITIES: ReadonlyArray<CandleSourceCapability> = [
  { interval: "1m", exchangePublicSupported: true, advancedTradeSupported: true },
  { interval: "5m", exchangePublicSupported: true, advancedTradeSupported: true },
  { interval: "15m", exchangePublicSupported: true, advancedTradeSupported: true },
  { interval: "30m", exchangePublicSupported: false, advancedTradeSupported: true, canDeriveFrom: "15m" },
  { interval: "1h", exchangePublicSupported: true, advancedTradeSupported: true },
  { interval: "2h", exchangePublicSupported: false, advancedTradeSupported: true, canDeriveFrom: "1h" },
  { interval: "4h", exchangePublicSupported: false, advancedTradeSupported: true, canDeriveFrom: "1h" },
  { interval: "6h", exchangePublicSupported: true, advancedTradeSupported: true },
  { interval: "1d", exchangePublicSupported: true, advancedTradeSupported: true },
];

export type CoinbaseMarketDataHealth =
  | { ok: true; source: "public_exchange" | "advanced_trade_auth"; lastSuccessAt: string }
  | { ok: false; reason: "COINBASE_AUTH_FAILED" | "PUBLIC_MARKET_DATA_FAILED" | "RATE_LIMITED" | "UNKNOWN"; lastSuccessAt?: string };

export type CoinbaseBrokerHealth =
  | { ok: true; canView: boolean; canTrade: boolean; canTransfer: false; lastSuccessAt: string }
  | { ok: false; reason: "COINBASE_AUTH_FAILED" | "MISSING_VIEW_PERMISSION" | "TRANSFER_PERMISSION_DETECTED" | "WRONG_SIGNATURE_ALGORITHM" | "UNKNOWN"; lastSuccessAt?: string };

