export type ExecutionReadinessStatus = "insufficient" | "partial" | "ready_for_research";

export type RequiredExecutionField =
  | "expected_price"
  | "actual_fill_price"
  | "order_type"
  | "maker_taker_flag"
  | "fees"
  | "spread"
  | "slippage"
  | "time_to_fill"
  | "partial_fill_status"
  | "quote_snapshot"
  | "decision_timestamp"
  | "fill_timestamp";

export type ExecutionDataReadiness = {
  readiness: ExecutionReadinessStatus;
  availableFields: string[];
  missingFields: string[];
  warnings: string[];
  makerTakerResearchAllowed: false;
  executionAllowed: false;
};

export type QuoteSnapshot = {
  symbol?: string | null;
  bid?: number | null;
  ask?: number | null;
  lastPrice?: number | null;
  midpoint?: number | null;
  capturedAt?: string | null;
  source?: string | null;
};

export type PaperExecutionSnapshot = {
  expectedPrice: number | null;
  actualFillPrice: null;
  orderType: "paper_market" | "unknown";
  makerTakerFlag: "not_applicable_paper" | "unknown";
  spreadBps: number | null;
  slippageBps: null;
  feesUsd: null;
  quoteSnapshot: QuoteSnapshot | null;
  decisionTimestamp: string;
  fillTimestamp: null;
  source: "paper_simulation";
};

export type ExecutionDataInput = Partial<Record<RequiredExecutionField, unknown>> & {
  expectedPrice?: unknown;
  actualFillPrice?: unknown;
  orderType?: unknown;
  makerTakerFlag?: unknown;
  feesUsd?: unknown;
  fees?: unknown;
  spreadBps?: unknown;
  spread?: unknown;
  slippageBps?: unknown;
  slippage?: unknown;
  timeToFillMs?: unknown;
  timeToFill?: unknown;
  partialFillStatus?: unknown;
  partialFill?: unknown;
  quoteSnapshot?: unknown;
  decisionTimestamp?: unknown;
  fillTimestamp?: unknown;
};

export const REQUIRED_EXECUTION_DATA_FIELDS: RequiredExecutionField[] = [
  "expected_price",
  "actual_fill_price",
  "order_type",
  "maker_taker_flag",
  "fees",
  "spread",
  "slippage",
  "time_to_fill",
  "partial_fill_status",
  "quote_snapshot",
  "decision_timestamp",
  "fill_timestamp",
];

const FIELD_ALIASES: Record<RequiredExecutionField, string[]> = {
  expected_price: ["expected_price", "expectedPrice", "proposed_price", "proposedPrice", "proposed_entry", "proposedEntry"],
  actual_fill_price: ["actual_fill_price", "actualFillPrice", "fill_price", "fillPrice", "execution_price", "executionPrice"],
  order_type: ["order_type", "orderType"],
  maker_taker_flag: ["maker_taker_flag", "makerTakerFlag", "liquidity", "liquidity_indicator"],
  fees: ["fees", "feesUsd", "fees_usd", "fee", "feeUsd", "fee_usd"],
  spread: ["spread", "spreadBps", "spread_bps", "spreadPct", "spread_pct"],
  slippage: ["slippage", "slippageBps", "slippage_bps", "slippagePct", "slippage_pct"],
  time_to_fill: ["time_to_fill", "timeToFill", "timeToFillMs", "time_to_fill_ms"],
  partial_fill_status: ["partial_fill_status", "partialFillStatus", "partialFill", "partial_fill"],
  quote_snapshot: ["quote_snapshot", "quoteSnapshot"],
  decision_timestamp: ["decision_timestamp", "decisionTimestamp", "decided_at", "decidedAt"],
  fill_timestamp: ["fill_timestamp", "fillTimestamp", "filled_at", "filledAt"],
};

const PAPER_ONLY_MAKER_TAKER_VALUES = new Set(["not_applicable_paper", "paper", "unknown", "n/a", "na", "none"]);

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function firstValue(input: Record<string, unknown>, field: RequiredExecutionField): unknown {
  for (const key of FIELD_ALIASES[field]) {
    if (hasOwn(input, key)) return input[key];
  }
  return undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function hasResearchGradeQuoteSnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const quote = value as Record<string, unknown>;
  const bid = quote.bid;
  const ask = quote.ask;
  const capturedAt = quote.capturedAt ?? quote.captured_at ?? quote.time ?? quote.timestamp;
  return isFiniteNumber(bid) && bid > 0 && isFiniteNumber(ask) && ask > 0 && ask >= bid && hasValue(capturedAt);
}

function fieldAvailable(input: Record<string, unknown>, field: RequiredExecutionField): boolean {
  const value = firstValue(input, field);

  if (field === "quote_snapshot") return hasResearchGradeQuoteSnapshot(value);

  if (field === "maker_taker_flag") {
    if (!hasValue(value)) return false;
    return !PAPER_ONLY_MAKER_TAKER_VALUES.has(String(value).toLowerCase());
  }

  return hasValue(value);
}

export function assessExecutionDataReadiness(input: ExecutionDataInput = {}): ExecutionDataReadiness {
  const record = input as Record<string, unknown>;
  const availableFields = REQUIRED_EXECUTION_DATA_FIELDS.filter((field) => fieldAvailable(record, field));
  const missingFields = REQUIRED_EXECUTION_DATA_FIELDS.filter((field) => !availableFields.includes(field));
  const warnings: string[] = [];

  if (!availableFields.includes("actual_fill_price")) {
    warnings.push("Actual fill price is missing; execution quality cannot be measured from proposal data alone.");
  }
  if (!availableFields.includes("fees")) {
    warnings.push("Fees are missing; net edge and maker-vs-taker cost comparisons would be misleading.");
  }
  if (!availableFields.includes("slippage")) {
    warnings.push("Slippage is missing; expected-vs-actual execution quality is not captured.");
  }
  if (!availableFields.includes("maker_taker_flag")) {
    warnings.push("Maker/taker flag is missing or paper-only; maker-vs-taker research remains blocked.");
  }
  if (!availableFields.includes("quote_snapshot")) {
    warnings.push("Research-grade quote snapshot with bid, ask, and timestamp is missing.");
  }
  if (!availableFields.includes("time_to_fill")) {
    warnings.push("Time-to-fill is missing; latency and partial-fill quality cannot be studied.");
  }

  const readiness: ExecutionReadinessStatus =
    missingFields.length === 0 ? "ready_for_research"
    : availableFields.length === 0 ? "insufficient"
    : "partial";

  if (readiness === "ready_for_research") {
    warnings.push("Readiness fields are present, but this audit helper still does not place orders or run maker/taker experiments.");
  }

  return {
    readiness,
    availableFields,
    missingFields,
    warnings,
    makerTakerResearchAllowed: false,
    executionAllowed: false,
  };
}

export type ExecutionSchemaAuditRow = {
  requiredField: RequiredExecutionField;
  existingStorage: string[];
  currentCapture: "explicit" | "partial" | "missing";
  risk: string;
  recommendation: string;
};

export const EXECUTION_SCHEMA_AUDIT: ExecutionSchemaAuditRow[] = [
  {
    requiredField: "expected_price",
    existingStorage: ["trade_signals.proposed_entry", "broker_fills.proposed_price", "trade_signals.context_snapshot.executionQualitySnapshot.expectedPrice"],
    currentCapture: "explicit",
    risk: "Proposal and fill paths use different names, so expected price must be normalized before analysis.",
    recommendation: "Use proposed_entry/proposed_price as expected_price and keep writing the paper execution-quality snapshot for new signals.",
  },
  {
    requiredField: "actual_fill_price",
    existingStorage: ["broker_fills.fill_price", "trades.entry_price / trades.exit_price"],
    currentCapture: "partial",
    risk: "Broker fills have true live fill prices, but paper rows may use proposed entry as entry_price and must not be treated as real fills.",
    recommendation: "For research, prefer broker_fills.fill_price; keep paper actualFillPrice null unless a simulator explicitly models fills.",
  },
  {
    requiredField: "order_type",
    existingStorage: ["trade_signals.context_snapshot.executionQualitySnapshot.orderType"],
    currentCapture: "partial",
    risk: "Historical live fills do not consistently expose market vs limit/IOC in a normalized field.",
    recommendation: "Store nullable execution metadata rather than inferring order type from strategy names or notes.",
  },
  {
    requiredField: "maker_taker_flag",
    existingStorage: ["none found as an explicit normalized field"],
    currentCapture: "missing",
    risk: "Maker-vs-taker research would be speculation without exchange liquidity indicators.",
    recommendation: "Capture the broker/exchange liquidity flag per fill before any maker-vs-taker experiment.",
  },
  {
    requiredField: "fees",
    existingStorage: ["broker_fills.fees_usd", "trades.entry_fees_usd", "trades.exit_fees_usd"],
    currentCapture: "partial",
    risk: "Live fees are captured, but paper snapshots intentionally leave feesUsd null instead of faking costs.",
    recommendation: "Keep live fees from broker_fills and add explicit simulated-fee metadata only if the paper simulator models it.",
  },
  {
    requiredField: "spread",
    existingStorage: ["trade_signals.context_snapshot.executionQualitySnapshot.spreadBps"],
    currentCapture: "partial",
    risk: "Current signal context often has last price but not bid/ask, so spread may be null.",
    recommendation: "Persist bid/ask quote snapshots at decision time to make spread research-grade.",
  },
  {
    requiredField: "slippage",
    existingStorage: ["broker_fills.slippage_pct", "trades.entry_slippage_pct"],
    currentCapture: "partial",
    risk: "Live slippage exists when proposed_price and fill_price are available; paper slippage remains null.",
    recommendation: "Normalize slippage units and do not backfill paper slippage without a simulator.",
  },
  {
    requiredField: "time_to_fill",
    existingStorage: ["none found as an explicit normalized field"],
    currentCapture: "missing",
    risk: "Cannot study queue behavior, execution latency, or IOC timing without request/fill timestamps.",
    recommendation: "Capture decision/order/fill timestamps and derive time_to_fill per fill.",
  },
  {
    requiredField: "partial_fill_status",
    existingStorage: ["trades.partial_fill", "broker_fills.base_size", "broker_fills.quote_size", "trades.requested_size"],
    currentCapture: "partial",
    risk: "Partial status exists on trades but not as normalized per-fill status across all paths.",
    recommendation: "Keep partial status nullable and compute from requested vs filled size when broker data is explicit.",
  },
  {
    requiredField: "quote_snapshot",
    existingStorage: ["trade_signals.context_snapshot.lastPrice", "trade_signals.context_snapshot.executionQualitySnapshot.quoteSnapshot"],
    currentCapture: "partial",
    risk: "Last price alone is not enough to reconstruct spread or maker/taker opportunity.",
    recommendation: "Persist bid, ask, last price, source, and timestamp at decision time.",
  },
  {
    requiredField: "decision_timestamp",
    existingStorage: ["trade_signals.created_at", "trade_signals.decided_at", "replay_packet.ranAt"],
    currentCapture: "explicit",
    risk: "Multiple timestamp names need normalization for analysis.",
    recommendation: "Normalize created_at/ranAt as decision_timestamp in analysis views.",
  },
  {
    requiredField: "fill_timestamp",
    existingStorage: ["broker_fills.created_at", "trades.opened_at", "trades.closed_at"],
    currentCapture: "partial",
    risk: "Broker fill timestamp is captured for live fills, but paper snapshots intentionally keep fillTimestamp null.",
    recommendation: "Use broker_fills.created_at for live fills and avoid treating paper opened_at as a real fill timestamp.",
  },
];

export const EXISTING_EXECUTION_DATA_AUDIT_TABLE = [
  {
    existingPiece: "trade_signals",
    currentExecutionDataCaptured: "proposed_entry, created_at/decided_at, context_snapshot, replay_packet; new signals can include a non-executing executionQualitySnapshot.",
    missingFields: "actual fill price, real fees, real slippage, maker/taker flag, time-to-fill, partial-fill status, research-grade bid/ask snapshot unless executionQualitySnapshot has it.",
    risk: "Signal proposals can look like execution data if proposal price is confused with a real fill.",
    recommendation: "Treat trade_signals as decision intent only; use executionQualitySnapshot for non-executing paper context and broker_fills for real fills.",
  },
  {
    existingPiece: "trades",
    currentExecutionDataCaptured: "entry_price, exit_price, fee/slippage rollups, partial_fill/requested_size, lifecycle timestamps, broker order ids.",
    missingFields: "normalized expected price, normalized order type, maker/taker flag, quote snapshot, per-fill time-to-fill.",
    risk: "Paper entry_price can be simulated/estimated and should not be used as proof of exchange fill quality.",
    recommendation: "Use trades for position lifecycle and rollups; join broker_fills for execution research.",
  },
  {
    existingPiece: "broker_fills",
    currentExecutionDataCaptured: "fill_price, proposed_price, fees_usd, slippage_pct, base_size, quote_size, broker/client order ids, raw broker payload, created_at.",
    missingFields: "normalized order_type, maker_taker_flag, explicit time_to_fill, decision quote snapshot.",
    risk: "This is the strongest live execution table, but still insufficient for maker-vs-taker without liquidity flags.",
    recommendation: "Extend broker fill metadata later with nullable order/liquidity/timing fields sourced from broker responses.",
  },
  {
    existingPiece: "paper trades/signals",
    currentExecutionDataCaptured: "proposed entry and market context; this PR adds a paper execution snapshot with null actual fill, fees, slippage, and fill timestamp.",
    missingFields: "real fill price, real fees, real maker/taker status, real fill timestamp, modeled paper execution if not explicitly simulated.",
    risk: "Paper mode can overstate readiness if simulated prices are mislabeled as broker fills.",
    recommendation: "Keep paper snapshots honest: source=paper_simulation and null for real execution fields until a simulator is implemented.",
  },
];

export function buildPaperExecutionSnapshot(params: {
  expectedPrice: number | null;
  symbol?: string | null;
  bid?: number | null;
  ask?: number | null;
  lastPrice?: number | null;
  capturedAt?: string | null;
  decisionTimestamp?: string | null;
  orderType?: "paper_market" | "unknown";
}): PaperExecutionSnapshot {
  const decisionTimestamp = params.decisionTimestamp ?? new Date().toISOString();
  const bid = isFiniteNumber(params.bid) && params.bid > 0 ? params.bid : null;
  const ask = isFiniteNumber(params.ask) && params.ask > 0 ? params.ask : null;
  const lastPrice = isFiniteNumber(params.lastPrice) && params.lastPrice > 0 ? params.lastPrice : null;
  const midpoint = bid !== null && ask !== null ? (bid + ask) / 2 : null;
  const spreadBps = bid !== null && ask !== null && midpoint && midpoint > 0
    ? ((ask - bid) / midpoint) * 10_000
    : null;
  const quoteSnapshot: QuoteSnapshot | null = bid !== null || ask !== null || lastPrice !== null
    ? {
        symbol: params.symbol ?? null,
        bid,
        ask,
        lastPrice,
        midpoint,
        capturedAt: params.capturedAt ?? decisionTimestamp,
        source: "paper_decision_snapshot",
      }
    : null;

  return {
    expectedPrice: isFiniteNumber(params.expectedPrice) && params.expectedPrice > 0 ? params.expectedPrice : null,
    actualFillPrice: null,
    orderType: params.orderType ?? "paper_market",
    makerTakerFlag: "not_applicable_paper",
    spreadBps,
    slippageBps: null,
    feesUsd: null,
    quoteSnapshot,
    decisionTimestamp,
    fillTimestamp: null,
    source: "paper_simulation",
  };
}
