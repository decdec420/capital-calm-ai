// ============================================================
// Regime-change soft-exit dry-run worker
// ------------------------------------------------------------
// Simulation and learning only. This module never imports broker/execution
// code and its storage adapter only inserts decision_memory +
// decision_memory_simulations rows. It never updates trades, stops,
// take-profits, doctrine, strategies, or signals.
// ============================================================

import {
  buildRegimeSoftExitDecisionMemoryShape,
  evaluateRegimeSoftExit,
  type RegimeSoftExitInput,
  type RegimeSoftExitSeverity,
  type RegimeSoftExitSimulation,
} from "./regime-soft-exit";

export const REGIME_SOFT_EXIT_SIMULATION_TYPE = "REGIME_CHANGE_SOFT_EXIT" as const;
export const REGIME_SOFT_EXIT_SOURCE = "regime_change_soft_exit" as const;
export const REGIME_SOFT_EXIT_DEDUP_WINDOW_MINUTES = 60;

export type RegimeSoftExitResultLabel =
  | "simulation_only"
  | "no_action"
  | "adverse_regime_flip"
  | "insufficient_data";

export interface RegimeSoftExitOpenTrade {
  id: string;
  user_id: string;
  symbol: string;
  side: string | null;
  entry_price: number | string | null;
  current_price?: number | string | null;
  unrealized_pnl?: number | string | null;
  opened_at: string;
  stop_loss?: number | string | null;
  take_profit?: number | string | null;
  reason_tags?: string[] | null;
  strategy_id?: string | null;
  strategy_version?: string | null;
  lifecycle_transitions?: unknown;
}

export interface RegimeSoftExitMarketIntel {
  user_id: string;
  symbol: string;
  market_phase?: string | null;
  trend_structure?: string | null;
  macro_bias?: string | null;
  environment_rating?: string | null;
  generated_at?: string | null;
}

export interface RegimeSoftExitStoredRecord {
  decisionMemoryId: string;
  simulationId: string;
}

export interface RegimeSoftExitStorage {
  listOpenTrades(): Promise<RegimeSoftExitOpenTrade[]>;
  getLatestMarketIntel(userId: string, symbol: string): Promise<RegimeSoftExitMarketIntel | null>;
  hasRecentSimulation(params: RegimeSoftExitDedupKey): Promise<boolean>;
  storeSimulation(record: RegimeSoftExitSimulationRecord): Promise<RegimeSoftExitStoredRecord | null>;
}

export interface RegimeSoftExitDedupKey {
  userId: string;
  tradeId: string;
  symbol: string;
  entryRegime: string | null;
  currentRegime: string | null;
  simulationType: typeof REGIME_SOFT_EXIT_SIMULATION_TYPE;
  withinMinutes: number;
}

export interface RegimeSoftExitSimulationRecord {
  userId: string;
  tradeId: string;
  symbol: string;
  side: string | null;
  strategyId: string | null;
  entryRegime: string | null;
  currentRegime: string | null;
  unrealizedPnl: number | null;
  timeInTradeMinutes: number | null;
  simulatedActions: string[];
  severity: RegimeSoftExitSeverity;
  reasonCodes: string[];
  executionAllowed: false;
  resultLabel: RegimeSoftExitResultLabel;
  source: typeof REGIME_SOFT_EXIT_SOURCE;
  createdAt: string;
  inputSnapshot: RegimeSoftExitInput & {
    tradeId: string;
    symbol: string;
    source: typeof REGIME_SOFT_EXIT_SOURCE;
  };
  result: RegimeSoftExitSimulation;
}

export interface RegimeSoftExitWorkerResult {
  tradeId: string;
  symbol: string;
  side: string | null;
  entryRegime: string | null;
  currentRegime: string | null;
  resultLabel: RegimeSoftExitResultLabel;
  simulatedActions: string[];
  severity: RegimeSoftExitSeverity;
  reasonCodes: string[];
  executionAllowed: false;
  stored: boolean;
  deduped: boolean;
  decisionMemoryId: string | null;
  simulationId: string | null;
}

export interface RunRegimeSoftExitWorkerResult {
  evaluated: number;
  stored: number;
  deduped: number;
  insufficientData: number;
  results: RegimeSoftExitWorkerResult[];
}

type SupabaseError = { message: string } | null;
type SupabaseQueryResult<T = unknown> = { data: T | null; error: SupabaseError };
type SupabaseQueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns?: string, options?: Record<string, unknown>): SupabaseQueryBuilder<T>;
  insert(values: Record<string, unknown>): SupabaseQueryBuilder<T>;
  eq(column: string, value: unknown): SupabaseQueryBuilder<T>;
  gte(column: string, value: unknown): SupabaseQueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): SupabaseQueryBuilder<T>;
  limit(count: number): SupabaseQueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T>>;
  single(): Promise<SupabaseQueryResult<T>>;
};
type SupabaseStorageClient = {
  from(table: string): SupabaseQueryBuilder;
};

const UNKNOWN_REGIMES = new Set(["", "unknown", "no_trade", "insufficient_data"]);
const ENTRY_REGIME_TAGS = new Set([
  "trending_up",
  "trending_down",
  "range",
  "chop",
  "markup",
  "markdown",
  "uptrend",
  "downtrend",
  "transitioning",
]);

function normalizeRegimeToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase().replace(/\s+/g, "_");
  if (!token || UNKNOWN_REGIMES.has(token)) return null;
  switch (token) {
    case "uptrend":
    case "markup":
    case "lean_long":
    case "strong_long":
      return "trending_up";
    case "downtrend":
    case "markdown":
    case "lean_short":
    case "strong_short":
      return "trending_down";
    case "transitioning":
      return "chop";
    case "accumulation":
    case "distribution":
      return "range";
    default:
      return token;
  }
}

function isKnownRegime(value: string | null): value is string {
  return !!value && !UNKNOWN_REGIMES.has(value);
}

export function deriveEntryRegimeFromTrade(trade: Pick<RegimeSoftExitOpenTrade, "reason_tags" | "lifecycle_transitions">): string | null {
  for (const tag of trade.reason_tags ?? []) {
    const normalized = normalizeRegimeToken(tag);
    if (normalized && ENTRY_REGIME_TAGS.has(tag.trim().toLowerCase().replace(/\s+/g, "_"))) {
      return normalized;
    }
  }

  if (Array.isArray(trade.lifecycle_transitions)) {
    for (const transition of trade.lifecycle_transitions) {
      if (!transition || typeof transition !== "object") continue;
      const meta = (transition as { meta?: Record<string, unknown> }).meta;
      const normalized = normalizeRegimeToken(meta?.entryRegime ?? meta?.marketRegime ?? meta?.regime);
      if (normalized) return normalized;
    }
  }

  return null;
}

export function deriveCurrentRegimeFromMarketIntel(intel: RegimeSoftExitMarketIntel | null): string | null {
  if (!intel) return null;
  return (
    normalizeRegimeToken(intel.trend_structure) ??
    normalizeRegimeToken(intel.market_phase) ??
    normalizeRegimeToken(intel.macro_bias)
  );
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function minutesSince(iso: string, nowMs: number): number | null {
  const openedMs = Date.parse(iso);
  if (!Number.isFinite(openedMs)) return null;
  return Math.max(0, Math.round((nowMs - openedMs) / 60_000));
}

function resultLabelFor(entryRegime: string | null, currentRegime: string | null, result: RegimeSoftExitSimulation): RegimeSoftExitResultLabel {
  if (!isKnownRegime(entryRegime) || !isKnownRegime(currentRegime)) return "insufficient_data";
  if (result.shouldSimulate) return "adverse_regime_flip";
  return "no_action";
}

export function buildRegimeSoftExitSimulationRecord(params: {
  trade: RegimeSoftExitOpenTrade;
  entryRegime: string | null;
  currentRegime: string | null;
  nowIso: string;
  nowMs: number;
}): RegimeSoftExitSimulationRecord {
  const unrealizedPnl = toNumber(params.trade.unrealized_pnl);
  const timeInTradeMinutes = minutesSince(params.trade.opened_at, params.nowMs);
  const input: RegimeSoftExitInput = {
    side: params.trade.side,
    entryRegime: params.entryRegime,
    currentRegime: params.currentRegime,
    unrealizedPnl,
    timeInTradeMinutes,
  };
  const shape = buildRegimeSoftExitDecisionMemoryShape(input);
  const label = resultLabelFor(params.entryRegime, params.currentRegime, shape.result);
  const reasonCodes = label === "insufficient_data"
    ? [...shape.result.reasonCodes, "INSUFFICIENT_REGIME_DATA"]
    : shape.result.reasonCodes;

  return {
    userId: params.trade.user_id,
    tradeId: params.trade.id,
    symbol: params.trade.symbol,
    side: params.trade.side,
    strategyId: params.trade.strategy_id ?? null,
    entryRegime: params.entryRegime,
    currentRegime: params.currentRegime,
    unrealizedPnl,
    timeInTradeMinutes,
    simulatedActions: label === "insufficient_data" ? ["NO_ACTION"] : shape.result.simulatedActions,
    severity: label === "adverse_regime_flip" ? shape.result.severity : "info",
    reasonCodes,
    executionAllowed: false,
    resultLabel: label,
    source: REGIME_SOFT_EXIT_SOURCE,
    createdAt: params.nowIso,
    inputSnapshot: {
      ...shape.inputSnapshot,
      tradeId: params.trade.id,
      symbol: params.trade.symbol,
      source: REGIME_SOFT_EXIT_SOURCE,
    },
    result: {
      ...evaluateRegimeSoftExit(input),
      executionAllowed: false,
      ...(label === "insufficient_data" ? { shouldSimulate: false, simulatedActions: ["NO_ACTION"] as const, severity: "info" as const, reasonCodes } : {}),
    },
  };
}

export async function runRegimeSoftExitSimulationWorker(
  storage: RegimeSoftExitStorage,
  options: { now?: Date; dedupWindowMinutes?: number } = {},
): Promise<RunRegimeSoftExitWorkerResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const withinMinutes = options.dedupWindowMinutes ?? REGIME_SOFT_EXIT_DEDUP_WINDOW_MINUTES;
  const results: RegimeSoftExitWorkerResult[] = [];
  const openTrades = await storage.listOpenTrades();

  for (const trade of openTrades) {
    const entryRegime = deriveEntryRegimeFromTrade(trade);
    const currentRegime = deriveCurrentRegimeFromMarketIntel(
      await storage.getLatestMarketIntel(trade.user_id, trade.symbol),
    );
    const record = buildRegimeSoftExitSimulationRecord({ trade, entryRegime, currentRegime, nowIso, nowMs });
    const alreadyStored = await storage.hasRecentSimulation({
      userId: trade.user_id,
      tradeId: trade.id,
      symbol: trade.symbol,
      entryRegime,
      currentRegime,
      simulationType: REGIME_SOFT_EXIT_SIMULATION_TYPE,
      withinMinutes,
    });

    let storedRecord: RegimeSoftExitStoredRecord | null = null;
    if (!alreadyStored) {
      storedRecord = await storage.storeSimulation(record);
    }

    results.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      entryRegime,
      currentRegime,
      resultLabel: record.resultLabel,
      simulatedActions: record.simulatedActions,
      severity: record.severity,
      reasonCodes: record.reasonCodes,
      executionAllowed: false,
      stored: !!storedRecord,
      deduped: alreadyStored,
      decisionMemoryId: storedRecord?.decisionMemoryId ?? null,
      simulationId: storedRecord?.simulationId ?? null,
    });
  }

  return {
    evaluated: results.length,
    stored: results.filter((r) => r.stored).length,
    deduped: results.filter((r) => r.deduped).length,
    insufficientData: results.filter((r) => r.resultLabel === "insufficient_data").length,
    results,
  };
}

export function createSupabaseRegimeSoftExitStorage(admin: SupabaseStorageClient): RegimeSoftExitStorage {
  return {
    async listOpenTrades() {
      const { data, error } = await admin
        .from("trades")
        .select("id,user_id,symbol,side,entry_price,current_price,unrealized_pnl,opened_at,stop_loss,take_profit,reason_tags,strategy_id,strategy_version,lifecycle_transitions")
        .eq("status", "open");
      if (error) throw new Error(`open trades load failed: ${error.message}`);
      return (data ?? []) as RegimeSoftExitOpenTrade[];
    },

    async getLatestMarketIntel(userId, symbol) {
      const { data, error } = await admin
        .from("market_intelligence")
        .select("user_id,symbol,market_phase,trend_structure,macro_bias,environment_rating,generated_at")
        .eq("user_id", userId)
        .eq("symbol", symbol)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`market intelligence load failed: ${error.message}`);
      return (data ?? null) as RegimeSoftExitMarketIntel | null;
    },

    async hasRecentSimulation(params) {
      const sinceIso = new Date(Date.now() - params.withinMinutes * 60_000).toISOString();
      const { data, error } = await admin
        .from("decision_memory_simulations")
        .select("id,input_snapshot,result,created_at")
        .eq("user_id", params.userId)
        .eq("symbol", params.symbol)
        .eq("simulation_type", params.simulationType)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(25);
      if (error) throw new Error(`simulation dedupe load failed: ${error.message}`);
      return ((data ?? []) as Array<{ input_snapshot?: Record<string, unknown>; result?: Record<string, unknown> }>).some((row) => {
        const snap = row.input_snapshot ?? {};
        const result = row.result ?? {};
        return snap.tradeId === params.tradeId &&
          snap.entryRegime === params.entryRegime &&
          snap.currentRegime === params.currentRegime &&
          result.source === REGIME_SOFT_EXIT_SOURCE;
      });
    },

    async storeSimulation(record) {
      const { data: memory, error: memoryError } = await admin
        .from("decision_memory")
        .insert({
          user_id: record.userId,
          symbol: record.symbol,
          strategy_id: record.strategyId,
          event_type: "simulation",
          source_agent: REGIME_SOFT_EXIT_SOURCE,
          reason_code: "REGIME_CHANGE_SOFT_EXIT_SIMULATION",
          severity: record.severity === "critical" ? "warn" : "skip",
          mode: "research",
          market_regime: record.currentRegime,
          confidence: null,
          setup_score: null,
          replay_packet: {
            ranAt: record.createdAt,
            symbol: record.symbol,
            regime: record.currentRegime,
            blockerCodes: record.reasonCodes,
            reason: "Regime-change soft-exit simulation only — no broker action or trade mutation.",
            meta: {
              source: REGIME_SOFT_EXIT_SOURCE,
              tradeId: record.tradeId,
              entryRegime: record.entryRegime,
              currentRegime: record.currentRegime,
              executionAllowed: false,
            },
          },
          blocker_codes: record.reasonCodes,
          used_for_learning: false,
        })
        .select("id")
        .single();
      if (memoryError) throw new Error(`decision_memory insert failed: ${memoryError.message}`);

      const result = {
        simulation_type: REGIME_SOFT_EXIT_SIMULATION_TYPE,
        result_label: record.resultLabel,
        source: REGIME_SOFT_EXIT_SOURCE,
        trade_id: record.tradeId,
        side: record.side,
        entry_regime: record.entryRegime,
        current_regime: record.currentRegime,
        unrealized_pnl: record.unrealizedPnl,
        time_in_trade_minutes: record.timeInTradeMinutes,
        simulated_actions: record.simulatedActions,
        severity: record.severity,
        reason_codes: record.reasonCodes,
        execution_allowed: false,
        should_simulate: record.result.shouldSimulate,
        completed_at: record.createdAt,
        operator_copy: "Simulation only — no trade was closed, no stop was changed, and no broker action was taken.",
      };

      const { data: sim, error: simError } = await admin
        .from("decision_memory_simulations")
        .insert({
          decision_memory_id: (memory as { id: string }).id,
          user_id: record.userId,
          symbol: record.symbol,
          strategy_id: record.strategyId,
          simulation_type: REGIME_SOFT_EXIT_SIMULATION_TYPE,
          status: "completed",
          lookahead_window: "0m",
          input_snapshot: record.inputSnapshot,
          result,
          score: null,
          started_at: record.createdAt,
          completed_at: record.createdAt,
          used_for_strategy_learning: false,
        })
        .select("id")
        .single();
      if (simError) throw new Error(`decision_memory_simulations insert failed: ${simError.message}`);

      return { decisionMemoryId: String((memory as { id: string }).id), simulationId: String((sim as { id: string }).id) };
    },
  };
}
