import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  REGIME_SOFT_EXIT_SIMULATION_TYPE,
  buildRegimeSoftExitSimulationRecord,
  createSupabaseRegimeSoftExitStorage,
  deriveCurrentRegimeFromMarketIntel,
  deriveEntryRegimeFromTrade,
  runRegimeSoftExitSimulationWorker,
  type RegimeSoftExitMarketIntel,
  type RegimeSoftExitOpenTrade,
  type RegimeSoftExitSimulationRecord,
  type RegimeSoftExitStorage,
} from "@/lib/regime-soft-exit-worker";

const NOW = new Date("2026-05-14T09:00:00.000Z");

function trade(overrides: Partial<RegimeSoftExitOpenTrade> = {}): RegimeSoftExitOpenTrade {
  return {
    id: "trade-1",
    user_id: "user-1",
    symbol: "BTC-USD",
    side: "long",
    entry_price: 100,
    current_price: 95,
    unrealized_pnl: -5,
    opened_at: "2026-05-14T08:00:00.000Z",
    stop_loss: 90,
    take_profit: 120,
    reason_tags: ["ai-signal", "trending_up"],
    strategy_id: "strategy-1",
    strategy_version: "test",
    lifecycle_transitions: [],
    ...overrides,
  };
}

function intel(overrides: Partial<RegimeSoftExitMarketIntel> = {}): RegimeSoftExitMarketIntel {
  return {
    user_id: "user-1",
    symbol: "BTC-USD",
    trend_structure: "downtrend",
    market_phase: "markdown",
    macro_bias: "lean_short",
    environment_rating: "unfavorable",
    generated_at: NOW.toISOString(),
    ...overrides,
  };
}

class FakeStorage implements RegimeSoftExitStorage {
  stored: RegimeSoftExitSimulationRecord[] = [];
  dedupedTradeIds = new Set<string>();

  constructor(
    private trades: RegimeSoftExitOpenTrade[],
    private intelBySymbol: Map<string, RegimeSoftExitMarketIntel | null>,
  ) {}

  async listOpenTrades() {
    return this.trades;
  }

  async getLatestMarketIntel(_userId: string, symbol: string) {
    return this.intelBySymbol.get(symbol) ?? null;
  }

  async hasRecentSimulation(params: { tradeId: string }) {
    return this.dedupedTradeIds.has(params.tradeId);
  }

  async storeSimulation(record: RegimeSoftExitSimulationRecord) {
    this.stored.push(record);
    return {
      decisionMemoryId: `dm-${record.tradeId}`,
      simulationId: `sim-${record.tradeId}`,
    };
  }
}

function storageFor(openTrade: RegimeSoftExitOpenTrade, currentIntel: RegimeSoftExitMarketIntel | null) {
  return new FakeStorage([openTrade], new Map([[openTrade.symbol, currentIntel]]));
}

describe("regime soft-exit dry-run worker", () => {
  it("creates a simulation-only adverse-flip result for long trending_up → trending_down", async () => {
    const fake = storageFor(trade(), intel());

    const result = await runRegimeSoftExitSimulationWorker(fake, { now: NOW });

    expect(result.evaluated).toBe(1);
    expect(result.stored).toBe(1);
    expect(result.results[0]).toMatchObject({
      resultLabel: "adverse_regime_flip",
      executionAllowed: false,
      stored: true,
      deduped: false,
    });
    expect(result.results[0].simulatedActions).toContain("TIGHTEN_STOP");
    expect(result.results[0].simulatedActions).toContain("REDUCE_POSITION_50");
    expect(fake.stored[0]).toMatchObject({
      resultLabel: "adverse_regime_flip",
      executionAllowed: false,
      source: "regime_change_soft_exit",
      entryRegime: "trending_up",
      currentRegime: "trending_down",
    });
  });

  it("creates a simulation-only adverse-flip result for short trending_down → trending_up", async () => {
    const fake = storageFor(
      trade({ id: "short-1", side: "short", reason_tags: ["ai-signal", "trending_down"] }),
      intel({ trend_structure: "uptrend", market_phase: "markup", macro_bias: "lean_long" }),
    );

    const result = await runRegimeSoftExitSimulationWorker(fake, { now: NOW });

    expect(result.results[0]).toMatchObject({
      resultLabel: "adverse_regime_flip",
      executionAllowed: false,
    });
    expect(fake.stored[0].simulatedActions).toContain("REDUCE_POSITION_50");
  });

  it("stores range/chop unchanged as no-action info-only", async () => {
    const fake = storageFor(
      trade({ reason_tags: ["range"] }),
      intel({ trend_structure: "range", market_phase: "accumulation", macro_bias: "neutral" }),
    );

    const result = await runRegimeSoftExitSimulationWorker(fake, { now: NOW });

    expect(result.results[0]).toMatchObject({
      resultLabel: "no_action",
      simulatedActions: ["NO_ACTION"],
      severity: "info",
      executionAllowed: false,
    });
  });

  it("returns insufficient_data when entry regime is missing", async () => {
    const fake = storageFor(trade({ reason_tags: ["ai-signal"] }), intel());

    const result = await runRegimeSoftExitSimulationWorker(fake, { now: NOW });

    expect(result.insufficientData).toBe(1);
    expect(result.results[0]).toMatchObject({
      entryRegime: null,
      resultLabel: "insufficient_data",
      simulatedActions: ["NO_ACTION"],
      executionAllowed: false,
    });
  });

  it("returns insufficient_data when current regime is missing", async () => {
    const fake = storageFor(trade(), null);

    const result = await runRegimeSoftExitSimulationWorker(fake, { now: NOW });

    expect(result.insufficientData).toBe(1);
    expect(result.results[0]).toMatchObject({
      currentRegime: null,
      resultLabel: "insufficient_data",
      simulatedActions: ["NO_ACTION"],
      executionAllowed: false,
    });
  });

  it("treats unknown regimes honestly and never executes", () => {
    const record = buildRegimeSoftExitSimulationRecord({
      trade: trade({ reason_tags: ["unknown"] }),
      entryRegime: deriveEntryRegimeFromTrade(trade({ reason_tags: ["unknown"] })),
      currentRegime: deriveCurrentRegimeFromMarketIntel(intel({ trend_structure: "unknown", market_phase: "unknown", macro_bias: "neutral" })),
      nowIso: NOW.toISOString(),
      nowMs: NOW.getTime(),
    });

    expect(record.resultLabel).toBe("insufficient_data");
    expect(record.result.executionAllowed).toBe(false);
    expect(record.executionAllowed).toBe(false);
    expect(record.simulatedActions).toEqual(["NO_ACTION"]);
  });

  it("does not store duplicate simulations for the same trade/regime pair inside the dedupe window", async () => {
    const fake = storageFor(trade(), intel());
    fake.dedupedTradeIds.add("trade-1");

    const result = await runRegimeSoftExitSimulationWorker(fake, { now: NOW, dedupWindowMinutes: 60 });

    expect(result.deduped).toBe(1);
    expect(result.stored).toBe(0);
    expect(fake.stored).toHaveLength(0);
    expect(result.results[0]).toMatchObject({ deduped: true, stored: false, executionAllowed: false });
  });

  it("storage result always carries executionAllowed=false", async () => {
    const fake = storageFor(trade(), intel());

    await runRegimeSoftExitSimulationWorker(fake, { now: NOW });

    expect(fake.stored[0].executionAllowed).toBe(false);
    expect(fake.stored[0].result.executionAllowed).toBe(false);
  });

  it("Supabase adapter only reads open trades, reads market intel, inserts memory/simulation rows, and never mutates trade execution state", () => {
    const source = readFileSync("src/lib/regime-soft-exit-worker.ts", "utf8");
    const adapterSource = source.slice(source.indexOf("export function createSupabaseRegimeSoftExitStorage"));

    expect(adapterSource).toContain(".from(\"trades\")");
    expect(adapterSource).toContain(".eq(\"status\", \"open\")");
    expect(adapterSource).toContain(".from(\"market_intelligence\")");
    expect(adapterSource).toContain(".from(\"decision_memory\")");
    expect(adapterSource).toContain(".from(\"decision_memory_simulations\")");
    expect(adapterSource).not.toMatch(/from\("trades"\)\s*\.update|from\("trades"\)\s*\.delete|from\("trades"\)\s*\.upsert/s);
    expect(adapterSource).not.toMatch(/stop_loss\s*:|take_profit\s*:|status\s*:\s*"closed"/);
    expect(adapterSource).not.toMatch(/coinbase|placeMarket|approve_signal/i);
    expect(adapterSource).not.toContain('.from("trade_signals")');
    expect(adapterSource).not.toContain('.from("doctrine');
    expect(adapterSource).not.toContain('.from("strategies")');
    expect(createSupabaseRegimeSoftExitStorage).toBeTypeOf("function");
  });

  it("the manual edge function remains on-demand and simulation-only", () => {
    const source = readFileSync("supabase/functions/simulate-regime-soft-exits/index.ts", "utf8");

    expect(source).toContain("On-demand only");
    expect(source).toContain("executionAllowed: false");
    expect(source).not.toMatch(/cron\.schedule|placeMarket|broker-execute/i);
    expect(source).not.toContain('.from("trade_signals")');
    expect(source).not.toContain('.from("doctrine');
    expect(source).not.toContain('.from("strategies")');
  });

  it("storage migration extends simulations safely and documents review-only behavior", () => {
    const migration = readFileSync("supabase/migrations/20260514090000_regime_soft_exit_simulations.sql", "utf8");

    expect(migration).toContain(REGIME_SOFT_EXIT_SIMULATION_TYPE);
    expect(migration).toContain("execution_allowed=false");
    expect(migration).not.toMatch(/UPDATE public\.(trades|trade_signals|doctrine)|INSERT INTO public\.trades/i);
  });
});
