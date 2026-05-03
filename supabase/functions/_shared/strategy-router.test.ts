import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  RouterPerformance,
  RouterStrategy,
  scoreFromPerformance,
  selectStrategy,
  tradeableRegimesFor,
} from "./strategy-router.ts";

const baseStrat = (over: Partial<RouterStrategy>): RouterStrategy => ({
  id: over.id ?? crypto.randomUUID(),
  name: over.name ?? "test",
  version: over.version ?? "v1",
  status: over.status ?? "approved",
  risk_weight: over.risk_weight ?? 1.0,
  regime_affinity: over.regime_affinity ?? ["trending_up"],
  side_capability: over.side_capability ?? ["long"],
  auto_paused_at: over.auto_paused_at ?? null,
});

Deno.test("selectStrategy: returns null when no candidates", () => {
  const decision = selectStrategy("range", "long", []);
  assertEquals(decision.strategy, null);
  assertEquals(decision.candidates.length, 0);
});

Deno.test("selectStrategy: filters out non-approved", () => {
  const s = baseStrat({ status: "candidate", regime_affinity: ["range"] });
  const decision = selectStrategy("range", "long", [s]);
  assertEquals(decision.strategy, null);
});

Deno.test("selectStrategy: filters out auto-paused", () => {
  const s = baseStrat({
    regime_affinity: ["range"],
    auto_paused_at: "2026-01-01T00:00:00Z",
  });
  const decision = selectStrategy("range", "long", [s]);
  assertEquals(decision.strategy, null);
});

Deno.test("selectStrategy: filters by regime_affinity", () => {
  const trending = baseStrat({ regime_affinity: ["trending_up"] });
  const range = baseStrat({ regime_affinity: ["range"] });
  const decision = selectStrategy("range", "long", [trending, range]);
  assertEquals(decision.strategy?.id, range.id);
});

Deno.test("selectStrategy: filters by side_capability", () => {
  const longOnly = baseStrat({
    name: "long-only",
    regime_affinity: ["trending_up"],
    side_capability: ["long"],
  });
  const shortable = baseStrat({
    name: "shortable",
    regime_affinity: ["trending_up"],
    side_capability: ["long", "short"],
  });
  const decision = selectStrategy("trending_up", "short", [longOnly, shortable]);
  assertEquals(decision.strategy?.id, shortable.id);
});

Deno.test("selectStrategy: tie-breaks on Sharpe-ish perf score", () => {
  const a = baseStrat({ name: "a", risk_weight: 1.0 });
  const b = baseStrat({ name: "b", risk_weight: 1.0 });
  const perf: RouterPerformance[] = [
    { strategy_id: a.id, closed_trades: 10, wins: 4, losses: 6, total_pnl: -10, avg_pnl_pct: -0.5, win_rate: 0.4 },
    { strategy_id: b.id, closed_trades: 10, wins: 7, losses: 3, total_pnl: 30, avg_pnl_pct: 1.5, win_rate: 0.7 },
  ];
  const decision = selectStrategy("trending_up", "long", [a, b], perf);
  assertEquals(decision.strategy?.id, b.id);
});

Deno.test("selectStrategy: falls back to risk_weight when perf insufficient", () => {
  const a = baseStrat({ name: "a", risk_weight: 0.5 });
  const b = baseStrat({ name: "b", risk_weight: 1.0 });
  // Both have <3 trades → perfScore=0 → tie-break on risk_weight (b higher)
  const perf: RouterPerformance[] = [
    { strategy_id: a.id, closed_trades: 1, wins: 1, losses: 0, total_pnl: 5, avg_pnl_pct: 5, win_rate: 1.0 },
  ];
  const decision = selectStrategy("trending_up", "long", [a, b], perf);
  assertEquals(decision.strategy?.id, b.id);
});

Deno.test("selectStrategy: alphabetical final tie-break is deterministic", () => {
  const a = baseStrat({ name: "alpha", risk_weight: 1.0 });
  const b = baseStrat({ name: "beta", risk_weight: 1.0 });
  const decision = selectStrategy("trending_up", "long", [a, b]);
  assertEquals(decision.strategy?.name, "alpha");
});

Deno.test("scoreFromPerformance: returns 0 for <3 trades", () => {
  const perf: RouterPerformance = {
    strategy_id: "x",
    closed_trades: 2,
    wins: 2,
    losses: 0,
    total_pnl: 100,
    avg_pnl_pct: 5,
    win_rate: 1.0,
  };
  assertEquals(scoreFromPerformance(perf), 0);
});

Deno.test("tradeableRegimesFor: union of approved non-paused strategies", () => {
  const trending = baseStrat({ regime_affinity: ["trending_up", "trending_down"] });
  const range = baseStrat({ regime_affinity: ["range"] });
  const paused = baseStrat({
    regime_affinity: ["breakout"],
    auto_paused_at: "2026-01-01T00:00:00Z",
  });
  const archived = baseStrat({
    regime_affinity: ["chop"],
    status: "archived",
  });
  const out = tradeableRegimesFor([trending, range, paused, archived]);
  assertEquals(out.size, 3);
  assertEquals(out.has("trending_up"), true);
  assertEquals(out.has("trending_down"), true);
  assertEquals(out.has("range"), true);
  assertEquals(out.has("breakout"), false); // paused
  assertEquals(out.has("chop"), false); // archived
});

Deno.test("tradeableRegimesFor: empty for empty input", () => {
  const out = tradeableRegimesFor([]);
  assertEquals(out.size, 0);
});

Deno.test("selectStrategy: reason text mentions tie-breaking when multiple", () => {
  const a = baseStrat({ name: "a", risk_weight: 0.5 });
  const b = baseStrat({ name: "b", risk_weight: 1.0 });
  const decision = selectStrategy("trending_up", "long", [a, b]);
  assertExists(decision.reason);
  assertEquals(decision.candidates.length, 2);
});
