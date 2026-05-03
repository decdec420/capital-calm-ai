// ============================================================
// Edge Dashboard
// ------------------------------------------------------------
// Phase 1 of the Diamond-Tier Edge Plan. Read-only surface that
// shows, per approved/candidate strategy:
//   • Identity (name, version, status)
//   • Risk weight (Kelly-lite multiplier on doctrine RISK_PER_TRADE_PCT)
//   • Regime affinity + side capability (set up for Phase 2 router)
//   • Live performance: trades, win rate, total/avg PnL, last close
//
// Source of truth: public.strategy_performance_v view (RLS-scoped
// to the current user via security_invoker).
// ============================================================

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, BarChart3, Layers, ShieldCheck, TrendingDown, TrendingUp } from "lucide-react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { EmptyState } from "@/components/trader/EmptyState";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

interface StrategyRow {
  strategy_id: string;
  strategy_name: string;
  strategy_version: string;
  status: string;
  risk_weight: number;
  regime_affinity: string[] | null;
  side_capability: string[] | null;
  total_trades: number;
  closed_trades: number;
  wins: number;
  losses: number;
  total_pnl: number;
  avg_pnl: number;
  avg_pnl_pct: number;
  win_rate: number | null;
  last_closed_at: string | null;
}

interface StrategyMeta {
  id: string;
  consecutive_losses: number;
  auto_paused_at: string | null;
  auto_pause_reason: string | null;
}

// Phase 3: bootstrap-ish CI + evidence verdict per strategy.
interface StrategyCIRow {
  strategy_id: string;
  strategy_name: string;
  strategy_version: string;
  closed_trades: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  win_rate_lo: number | null;
  win_rate_hi: number | null;
  avg_pnl: number | null;
  avg_pnl_lo: number | null;
  avg_pnl_hi: number | null;
  sharpe: number | null;
  sharpe_lo: number | null;
  sharpe_hi: number | null;
  evidence_status: "no_data" | "insufficient_evidence" | "developing" | "sufficient";
  edge_verdict: "unproven" | "positive_edge" | "negative_edge" | "inconclusive";
}

interface RouterDecisionRow {
  id: string;
  symbol: string;
  side: string;
  regime: string;
  created_at: string;
  context_snapshot: {
    routerDecision?: {
      chosenStrategyName: string | null;
      chosenStrategyVersion: string | null;
      reason: string;
      candidates: Array<{ id: string; name: string; version: string; score: number }>;
    };
    syntheticShort?: boolean;
  } | null;
}

const STATUS_TONE: Record<string, string> = {
  approved: "bg-success/10 text-success border-success/20",
  candidate: "bg-warning/10 text-warning border-warning/20",
  paused: "bg-destructive/10 text-destructive border-destructive/20",
  archived: "bg-muted text-muted-foreground border-border",
};

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(decimals)}%`;
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "no trades yet";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function Edge() {
  const [rows, setRows] = useState<StrategyRow[] | null>(null);
  const [metaById, setMetaById] = useState<Record<string, StrategyMeta>>({});
  const [ciById, setCiById] = useState<Record<string, StrategyCIRow>>({});
  const [recentRouter, setRecentRouter] = useState<RouterDecisionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    const [perfRes, metaRes, ciRes, sigRes] = await Promise.all([
      supabase
        .from("strategy_performance_v" as never)
        .select("*")
        .order("status", { ascending: true })
        .order("total_pnl", { ascending: false }),
      supabase
        .from("strategies")
        .select("id, consecutive_losses, auto_paused_at, auto_pause_reason"),
      supabase
        .from("strategy_performance_ci_v" as never)
        .select("*"),
      supabase
        .from("trade_signals")
        .select("id, symbol, side, regime, created_at, context_snapshot")
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    if (perfRes.error) {
      setError(perfRes.error.message);
      setRows([]);
      return;
    }
    setRows((perfRes.data ?? []) as unknown as StrategyRow[]);
    const metaMap: Record<string, StrategyMeta> = {};
    for (const m of (metaRes.data ?? []) as StrategyMeta[]) {
      metaMap[m.id] = m;
    }
    setMetaById(metaMap);
    const ciMap: Record<string, StrategyCIRow> = {};
    for (const c of ((ciRes.data ?? []) as unknown as StrategyCIRow[])) {
      ciMap[c.strategy_id] = c;
    }
    setCiById(ciMap);
    setRecentRouter((sigRes.data ?? []) as unknown as RouterDecisionRow[]);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load();
    })();
    return () => {
      cancelled = true;
      void cancelled;
    };
  }, []);

  const rearmStrategy = async (strategyId: string) => {
    setBusyId(strategyId);
    const { error: updErr } = await supabase
      .from("strategies")
      .update({
        status: "approved",
        consecutive_losses: 0,
        auto_paused_at: null,
        auto_pause_reason: null,
      })
      .eq("id", strategyId);
    setBusyId(null);
    if (!updErr) await load();
  };

  // Portfolio rollup
  const approved = (rows ?? []).filter((r) => r.status === "approved");
  const totalWeight = approved.reduce((s, r) => s + Number(r.risk_weight ?? 0), 0);
  const portfolioPnl = (rows ?? []).reduce((s, r) => s + Number(r.total_pnl ?? 0), 0);
  const portfolioTrades = (rows ?? []).reduce((s, r) => s + Number(r.closed_trades ?? 0), 0);

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Phase 2"
        title="Edge"
        description="Per-strategy performance, regime router decisions, and circuit-breaker status. The portfolio that actually generates the money."
      />

      {/* Portfolio summary strip */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Layers className="h-3.5 w-3.5" />
            Approved strategies
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {approved.length}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {(rows ?? []).length} total · {portfolioTrades} closed trades
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            Total risk weight (approved)
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {totalWeight.toFixed(2)}×
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Multiplier applied to doctrine risk-per-trade %
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {portfolioPnl >= 0 ? (
              <TrendingUp className="h-3.5 w-3.5 text-success" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5 text-destructive" />
            )}
            Portfolio realized PnL
          </div>
          <div
            className={cn(
              "mt-1 text-2xl font-semibold tabular-nums",
              portfolioPnl > 0 && "text-success",
              portfolioPnl < 0 && "text-destructive",
            )}
          >
            {fmtUsd(portfolioPnl)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Across all strategies
          </div>
        </div>
      </div>

      {/* Phase 3 — Statistical honesty panel.
          Every strategy reported with 95% CIs (Wilson on win-rate,
          t-based on expectancy) and an evidence_status flag. The point:
          before risking real money, distinguish proven edge from a hot streak. */}
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3 flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <div>
            <div className="text-sm font-medium">Statistical honesty</div>
            <div className="text-xs text-muted-foreground">
              95% confidence intervals on every metric. Anything with fewer than 30 closed trades is "unproven" — point estimates lie.
            </div>
          </div>
        </div>
        {(rows ?? []).length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            No strategies to evaluate yet.
          </div>
        ) : (
          <div className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Strategy</th>
                  <th className="px-4 py-2 text-left font-medium">Evidence</th>
                  <th className="px-4 py-2 text-right font-medium">Win rate (95% CI)</th>
                  <th className="px-4 py-2 text-right font-medium">Expectancy $ (95% CI)</th>
                  <th className="px-4 py-2 text-right font-medium">Sharpe (per trade)</th>
                  <th className="px-4 py-2 text-left font-medium">Verdict</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(rows ?? []).map((r) => {
                  const ci = ciById[r.strategy_id];
                  const ev = ci?.evidence_status ?? "no_data";
                  const verdict = ci?.edge_verdict ?? "unproven";
                  const evTone =
                    ev === "sufficient" ? "text-success border-success/30"
                    : ev === "developing" ? "text-warning border-warning/30"
                    : "text-muted-foreground border-border";
                  const verdictTone =
                    verdict === "positive_edge" ? "bg-success/10 text-success border-success/30"
                    : verdict === "negative_edge" ? "bg-destructive/10 text-destructive border-destructive/30"
                    : verdict === "inconclusive" ? "bg-warning/10 text-warning border-warning/30"
                    : "bg-muted text-muted-foreground border-border";
                  const fmtCi = (lo: number | null | undefined, hi: number | null | undefined, fmt: (n: number) => string) =>
                    lo == null || hi == null ? "—" : `[${fmt(lo)}, ${fmt(hi)}]`;
                  return (
                    <tr key={`ci-${r.strategy_id}`} className="hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <span className="font-medium">{r.strategy_name}</span>{" "}
                        <span className="text-xs text-muted-foreground">{r.strategy_version}</span>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={cn("text-[10px]", evTone)}>
                          {ev.replace(/_/g, " ")}
                        </Badge>
                        <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                          n={ci?.closed_trades ?? 0}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <div>{fmtPct(ci?.win_rate, 0)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {fmtCi(ci?.win_rate_lo, ci?.win_rate_hi, (n) => `${(n * 100).toFixed(0)}%`)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <div>{fmtUsd(ci?.avg_pnl)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {fmtCi(ci?.avg_pnl_lo, ci?.avg_pnl_hi, (n) => fmtUsd(n))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <div>{ci?.sharpe == null ? "—" : ci.sharpe.toFixed(2)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {fmtCi(ci?.sharpe_lo, ci?.sharpe_hi, (n) => n.toFixed(2))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={cn("text-[10px] uppercase tracking-wide", verdictTone)}>
                          {verdict.replace(/_/g, " ")}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-border bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
          Methodology: Wilson score interval on win-rate, t-based 95% CI on expectancy, Lo (2002) standard error on per-trade Sharpe. "Positive edge" requires the lower bound of expectancy to be above $0.
        </div>
      </div>

      {/* Strategies table */}
      {rows === null ? (
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Loading strategies…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          Could not load strategies: {error}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No strategies yet"
          description="Once strategies are seeded you'll see per-strategy performance here."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Strategy</th>
                <th className="px-4 py-3 text-left font-medium">Regime fit</th>
                <th className="px-4 py-3 text-left font-medium">Sides</th>
                <th className="px-4 py-3 text-right font-medium">Risk weight</th>
                <th className="px-4 py-3 text-right font-medium">Trades</th>
                <th className="px-4 py-3 text-right font-medium">Win rate</th>
                <th className="px-4 py-3 text-right font-medium">Total PnL</th>
                <th className="px-4 py-3 text-right font-medium">Avg %</th>
                <th className="px-4 py-3 text-right font-medium">Last close</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => {
                const pnl = Number(r.total_pnl ?? 0);
                const avgPct = Number(r.avg_pnl_pct ?? 0);
                return (
                  <tr key={r.strategy_id} className="hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{r.strategy_name}</span>
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] uppercase tracking-wide",
                              STATUS_TONE[r.status] ?? STATUS_TONE.archived,
                            )}
                          >
                            {r.status}
                          </Badge>
                          {metaById[r.strategy_id]?.auto_paused_at && (
                            <button
                              type="button"
                              disabled={busyId === r.strategy_id}
                              onClick={() => rearmStrategy(r.strategy_id)}
                              className="text-[10px] font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
                            >
                              {busyId === r.strategy_id ? "re-arming…" : "re-arm"}
                            </button>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {r.strategy_version}
                          {(metaById[r.strategy_id]?.consecutive_losses ?? 0) > 0 && (
                            <span className="ml-2 text-warning">
                              · {metaById[r.strategy_id].consecutive_losses} loss streak
                            </span>
                          )}
                          {metaById[r.strategy_id]?.auto_pause_reason && (
                            <span className="ml-2 text-destructive">
                              · {metaById[r.strategy_id].auto_pause_reason}
                            </span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(r.regime_affinity ?? []).length === 0 ? (
                          <span className="text-xs text-muted-foreground">any</span>
                        ) : (
                          (r.regime_affinity ?? []).map((reg) => (
                            <Badge
                              key={reg}
                              variant="outline"
                              className="text-[10px] font-normal"
                            >
                              {reg}
                            </Badge>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {(r.side_capability ?? ["long"]).map((side) => (
                          <Badge
                            key={side}
                            variant="outline"
                            className={cn(
                              "text-[10px] font-normal",
                              side === "long" && "text-success border-success/30",
                              side === "short" && "text-destructive border-destructive/30",
                            )}
                          >
                            {side}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {Number(r.risk_weight ?? 1).toFixed(2)}×
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {r.closed_trades}
                      {r.wins + r.losses > 0 && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({r.wins}W/{r.losses}L)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {fmtPct(r.win_rate, 0)}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-3 text-right tabular-nums",
                        pnl > 0 && "text-success",
                        pnl < 0 && "text-destructive",
                      )}
                    >
                      {fmtUsd(pnl)}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-3 text-right tabular-nums",
                        avgPct > 0 && "text-success",
                        avgPct < 0 && "text-destructive",
                      )}
                    >
                      {avgPct === 0 ? "—" : `${avgPct > 0 ? "+" : ""}${avgPct.toFixed(2)}%`}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground">
                      {fmtAgo(r.last_closed_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent router decisions — Phase 2 transparency */}
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <div className="text-sm font-medium">Recent router decisions</div>
          <div className="text-xs text-muted-foreground">
            Last 10 signals · which strategy fired and why
          </div>
        </div>
        {recentRouter.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            No signals yet. The router will log its picks here as they fire.
          </div>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {recentRouter.map((s) => {
              const rd = s.context_snapshot?.routerDecision;
              const synth = s.context_snapshot?.syntheticShort;
              return (
                <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
                  <div className="flex flex-col">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{s.symbol}</span>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px] uppercase",
                          s.side === "long" && "text-success border-success/30",
                          s.side === "short" && "text-destructive border-destructive/30",
                        )}
                      >
                        {s.side}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {s.regime}
                      </Badge>
                      {synth && (
                        <Badge variant="outline" className="text-[10px] text-warning border-warning/30">
                          synthetic short
                        </Badge>
                      )}
                    </div>
                    <span className="mt-1 text-xs text-muted-foreground">
                      {rd?.chosenStrategyName
                        ? `→ ${rd.chosenStrategyName} v${rd.chosenStrategyVersion}: ${rd.reason}`
                        : "no router decision recorded"}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {fmtAgo(s.created_at)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-end">
        <Link
          to="/strategy"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Open Strategy Lab
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}
