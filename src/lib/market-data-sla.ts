// ============================================================
// Market Data SLA + Provenance Layer — P0.3
// ------------------------------------------------------------
// Defines staleness thresholds per data type.
// Paper mode degrades on stale non-critical data.
// Live mode blocks entries on critical stale data.
//
// No new DB queries — computed from existing timestamps.
// ============================================================

export type DataType =
  | "ticker"
  | "candles_1m"
  | "candles_5m"
  | "candles_15m"
  | "candles_1h"
  | "candles_4h"
  | "brain_trust_momentum"
  | "brain_trust_narrative"
  | "broker_health"
  | "mark_to_market";

export interface DataSLA {
  /** Human-readable name for UI display. */
  label: string;
  /** Maximum acceptable age in seconds before data is considered stale. */
  staleThresholdSeconds: number;
  /**
   * If true and data is stale, paper mode should degrade (warn but not block).
   * If false, paper mode ignores staleness for this data type.
   */
  degradesPaper: boolean;
  /**
   * If true and data is stale, live mode should block new entries.
   * If false, live mode warns but does not block.
   */
  blocksLive: boolean;
  /** Category for grouping in UI. */
  category: "price" | "intelligence" | "broker" | "valuation";
}

export const MARKET_DATA_SLA: Record<DataType, DataSLA> = {
  ticker: {
    label: "Current price (ticker)",
    staleThresholdSeconds: 30,
    degradesPaper: false,
    blocksLive: true,
    category: "price",
  },
  candles_1m: {
    label: "1-minute candles",
    staleThresholdSeconds: 120,
    degradesPaper: false,
    blocksLive: true,
    category: "price",
  },
  candles_5m: {
    label: "5-minute candles",
    staleThresholdSeconds: 360,
    degradesPaper: false,
    blocksLive: true,
    category: "price",
  },
  candles_15m: {
    label: "15-minute candles",
    staleThresholdSeconds: 1200,
    degradesPaper: true,
    blocksLive: true,
    category: "price",
  },
  candles_1h: {
    label: "1-hour candles",
    staleThresholdSeconds: 3900,
    degradesPaper: false,
    blocksLive: true,
    category: "price",
  },
  candles_4h: {
    label: "4-hour candles (derived)",
    staleThresholdSeconds: 15000,
    degradesPaper: false,
    blocksLive: false,
    category: "price",
  },
  brain_trust_momentum: {
    label: "Brain Trust momentum",
    staleThresholdSeconds: 7200, // 2 hours
    degradesPaper: false,
    blocksLive: true,
    category: "intelligence",
  },
  brain_trust_narrative: {
    label: "Brain Trust narrative",
    staleThresholdSeconds: 14400, // 4 hours
    degradesPaper: false,
    blocksLive: false,
    category: "intelligence",
  },
  broker_health: {
    label: "Broker connection health",
    staleThresholdSeconds: 300,
    degradesPaper: false,
    blocksLive: true,
    category: "broker",
  },
  mark_to_market: {
    label: "Mark-to-market (PnL)",
    staleThresholdSeconds: 60,
    degradesPaper: true,
    blocksLive: true,
    category: "valuation",
  },
};

// ─── Provenance tag ───────────────────────────────────────────────────────────

export type DataSource = "public_exchange" | "authenticated_api" | "derived" | "cached" | "unknown";

export interface DataProvenanceTag {
  dataType: DataType;
  label: string;
  source: DataSource;
  /** ISO timestamp of the last successful fetch. Null if never fetched. */
  lastFetchedAt: string | null;
  /** Whether the data is derived from another interval (e.g. 4h from 1h). */
  isDerived: boolean;
  /** Whether a fallback data source was used instead of the primary. */
  fallbackUsed: boolean;
  /** The SLA threshold for this data type. */
  staleThresholdSeconds: number;
  /** Whether the data is currently stale according to the SLA. */
  isStale: boolean;
  /** Age in seconds. Infinity if never fetched. */
  ageSeconds: number;
  /** Whether staleness blocks live mode entries. */
  blocksLive: boolean;
  /** Whether staleness degrades paper mode. */
  degradesPaper: boolean;
}

/**
 * Computes a DataProvenanceTag for a given data type and last-fetch timestamp.
 */
export function buildProvenanceTag(
  dataType: DataType,
  lastFetchedAt: string | null,
  source: DataSource = "unknown",
  fallbackUsed = false,
  nowMs: number = Date.now(),
): DataProvenanceTag {
  const sla = MARKET_DATA_SLA[dataType];
  const ageSeconds = lastFetchedAt
    ? Math.max(0, (nowMs - Date.parse(lastFetchedAt)) / 1000)
    : Infinity;
  const isStale = ageSeconds > sla.staleThresholdSeconds;

  return {
    dataType,
    label: sla.label,
    source,
    lastFetchedAt,
    isDerived: source === "derived",
    fallbackUsed,
    staleThresholdSeconds: sla.staleThresholdSeconds,
    isStale,
    ageSeconds,
    blocksLive: sla.blocksLive,
    degradesPaper: sla.degradesPaper,
  };
}

/**
 * Returns a human-readable age string for UI display.
 * e.g. "just now", "2m ago", "1h 30m ago", "stale"
 */
export function formatDataAge(ageSeconds: number, isStale: boolean): string {
  if (!isFinite(ageSeconds)) return "never";
  if (isStale) {
    const m = Math.round(ageSeconds / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `stale · ${h}h ${m % 60}m ago`;
    return `stale · ${m}m ago`;
  }
  if (ageSeconds < 5) return "just now";
  if (ageSeconds < 60) return `${Math.round(ageSeconds)}s ago`;
  if (ageSeconds < 3600) return `${Math.round(ageSeconds / 60)}m ago`;
  const h = Math.floor(ageSeconds / 3600);
  const m = Math.round((ageSeconds % 3600) / 60);
  return `${h}h ${m}m ago`;
}
