// ============================================================
// Strategy Router (Phase 2)
// ------------------------------------------------------------
// Pure module. Given a list of approved strategies, the current
// regime for a symbol, and the desired side, pick the best-fit
// strategy. Used by signal-engine to replace the old "single
// approved strategy" model with a regime-aware portfolio.
//
// Tie-break order:
//   1. Filter to status='approved' AND auto_pause not engaged
//   2. Filter to regime_affinity contains current regime
//   3. Filter to side_capability contains desired side
//   4. Pick highest recent Sharpe (from strategy_performance_v)
//   5. Fall back to highest risk_weight
//   6. Fall back to alphabetical (deterministic)
// ============================================================

export type RegimeLabel =
  | "trending_up"
  | "trending_down"
  | "range"
  | "chop"
  | "breakout"
  | "no_trade";

export type Side = "long" | "short";

export interface RouterStrategy {
  id: string;
  name: string;
  version: string;
  status: string;
  risk_weight: number;
  regime_affinity: string[];
  side_capability: string[];
  auto_paused_at?: string | null;
  // Live params (passed to engine for EMA/RSI/stop tuning).
  params?: Array<{ key: string; value: number | string | boolean }>;
}

export interface RouterPerformance {
  strategy_id: string;
  closed_trades: number;
  wins: number;
  losses: number;
  total_pnl: number;
  avg_pnl_pct: number;
  win_rate: number;
}

export interface RouterDecision {
  strategy: RouterStrategy | null;
  reason: string;
  /** Diagnostic — what we considered before tie-breaking. */
  candidates: Array<{ id: string; name: string; version: string; score: number }>;
}

/**
 * Derive a "recent Sharpe-ish" score from the rolling stats view.
 * We don't have stdev of returns in the view (yet), so approximate as:
 *   avg_pnl_pct × win_rate  (positive expectancy with bias toward consistency)
 * Strategies with <3 closed trades return 0 (insufficient data — fall through
 * to risk_weight tie-break).
 */
export function scoreFromPerformance(
  perf: RouterPerformance | undefined,
): number {
  if (!perf || perf.closed_trades < 3) return 0;
  const wr = Number(perf.win_rate ?? 0);
  const avgPct = Number(perf.avg_pnl_pct ?? 0);
  return avgPct * wr;
}

export function selectStrategy(
  regime: RegimeLabel,
  side: Side,
  strategies: RouterStrategy[],
  performance: RouterPerformance[] = [],
): RouterDecision {
  const perfById = new Map(performance.map((p) => [p.strategy_id, p]));

  const eligible = strategies.filter(
    (s) =>
      s.status === "approved" &&
      !s.auto_paused_at &&
      Array.isArray(s.regime_affinity) &&
      s.regime_affinity.includes(regime) &&
      Array.isArray(s.side_capability) &&
      s.side_capability.includes(side),
  );

  if (eligible.length === 0) {
    return {
      strategy: null,
      reason: `no approved strategy for regime=${regime} side=${side}`,
      candidates: [],
    };
  }

  const scored = eligible
    .map((s) => ({
      strategy: s,
      perfScore: scoreFromPerformance(perfById.get(s.id)),
      riskWeight: Number(s.risk_weight ?? 0),
    }))
    .sort((a, b) => {
      if (b.perfScore !== a.perfScore) return b.perfScore - a.perfScore;
      if (b.riskWeight !== a.riskWeight) return b.riskWeight - a.riskWeight;
      return a.strategy.name.localeCompare(b.strategy.name);
    });

  const winner = scored[0].strategy;
  return {
    strategy: winner,
    reason: scored.length === 1
      ? `only candidate for ${regime}/${side}`
      : `picked ${winner.name} v${winner.version} (perfScore=${scored[0].perfScore.toFixed(3)}, riskWeight=${scored[0].riskWeight}) over ${scored.length - 1} other candidate(s)`,
    candidates: scored.map((s) => ({
      id: s.strategy.id,
      name: s.strategy.name,
      version: s.strategy.version,
      score: s.perfScore,
    })),
  };
}

/**
 * Compute the union of regimes that AT LEAST ONE approved, non-auto-paused
 * strategy can trade. Used by signal-engine to decide which symbols to
 * even consider — a symbol whose regime no strategy can trade is skipped.
 */
export function tradeableRegimesFor(
  strategies: RouterStrategy[],
): Set<RegimeLabel> {
  const out = new Set<RegimeLabel>();
  for (const s of strategies) {
    if (s.status !== "approved") continue;
    if (s.auto_paused_at) continue;
    for (const r of s.regime_affinity ?? []) {
      out.add(r as RegimeLabel);
    }
  }
  return out;
}
