import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { anyRefusal, evaluateRiskGates, isRefusal } from "./risk.ts";

const baseCtx = {
  symbol: "BTC-USD",
  equityUsd: 100,
  dailyRealizedPnlUsd: 0,
  dailyTradeCount: 0,
  killSwitchEngaged: false,
  botStatus: "running",
  hasOpenPosition: false,
  hasPendingSignal: false,
  nowIso: "2026-04-20T18:00:00Z",
};

Deno.test("risk — happy path returns no refusal", () => {
  const r = evaluateRiskGates({ ...baseCtx });
  assertEquals(anyRefusal(r), false);
});

Deno.test("risk — non-whitelisted symbol blocks outright", () => {
  const r = evaluateRiskGates({ ...baseCtx, symbol: "DOGE-USD" });
  assertEquals(anyRefusal(r), true);
  assertEquals(r[0].code, "DOCTRINE_SYMBOL_NOT_ALLOWED");
});

Deno.test("risk — kill switch halts", () => {
  const r = evaluateRiskGates({ ...baseCtx, killSwitchEngaged: true });
  assertEquals(r.some((x) => x.code === "KILL_SWITCH"), true);
  assertEquals(anyRefusal(r), true);
});

Deno.test("risk — daily trade count cap halts", () => {
  const r = evaluateRiskGates({ ...baseCtx, dailyTradeCount: 5 });
  assertEquals(r.some((x) => x.code === "TRADE_COUNT_CAP"), true);
});

Deno.test("risk — daily loss cap halts", () => {
  const r = evaluateRiskGates({
    ...baseCtx,
    dailyRealizedPnlUsd: -1.5,
  });
  assertEquals(r.some((x) => x.code === "DAILY_LOSS_CAP"), true);
});

Deno.test("risk — balance floor halts below $8", () => {
  const r = evaluateRiskGates({ ...baseCtx, equityUsd: 5 });
  assertEquals(r.some((x) => x.code === "BALANCE_FLOOR"), true);
});

Deno.test("risk — open position blocks new signal on same symbol", () => {
  const r = evaluateRiskGates({ ...baseCtx, hasOpenPosition: true });
  assertEquals(r.some((x) => x.code === "OPEN_POSITION"), true);
  // open position is "block" severity
  assertEquals(r.find((x) => x.code === "OPEN_POSITION")?.severity, "block");
});

Deno.test("risk — stale candle produces a skip", () => {
  const r = evaluateRiskGates({
    ...baseCtx,
    latestCandleEndedAt: "2026-04-20T17:50:00Z", // 10 min old > 180s
  });
  const stale = r.find((x) => x.code === "STALE_DATA");
  assertEquals(stale?.severity, "skip");
  // skips are NOT refusals
  assertEquals(stale ? isRefusal(stale) : false, false);
});

Deno.test("risk — wide spread produces a skip", () => {
  const r = evaluateRiskGates({ ...baseCtx, bid: 50_000, ask: 50_500 });
  // 500 / mid ≈ 99.5 bps > 30 bps cap
  assertEquals(r.some((x) => x.code === "SPREAD_TOO_WIDE"), true);
});

Deno.test("risk — guardrail blocked halts", () => {
  const r = evaluateRiskGates({
    ...baseCtx,
    guardrails: [{ label: "Daily loss", level: "blocked", utilization: 1 }],
  });
  assertEquals(r.some((x) => x.code === "GUARDRAIL_BLOCKED"), true);
});
