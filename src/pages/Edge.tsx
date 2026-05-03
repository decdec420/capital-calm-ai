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
import { ArrowUpRight, Layers, ShieldCheck, TrendingDown, TrendingUp } from "lucide-react";
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("strategy_performance_v" as never)
        .select("*")
        .order("status", { ascending: true })
        .order("total_pnl", { ascending: false });
      if (cancelled) return;
      if (error) {
        setError(error.message);
        setRows([]);
        return;
      }
      setRows((data ?? []) as unknown as StrategyRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Portfolio rollup
  const approved = (rows ?? []).filter((r) => r.status === "approved");
  const totalWeight = approved.reduce((s, r) => s + Number(r.risk_weight ?? 0), 0);
  const portfolioPnl = (rows ?? []).reduce((s, r) => s + Number(r.total_pnl ?? 0), 0);
  const portfolioTrades = (rows ?? []).reduce((s, r) => s + Number(r.closed_trades ?? 0), 0);

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Phase 1"
        title="Edge"
        description="Per-strategy performance, regime affinity, and risk budget. The portfolio that actually generates the money."
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
                        <div className="flex items-center gap-2">
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
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {r.strategy_version}
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

      {/* What's coming next */}
      <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4 text-sm">
        <div className="font-medium">Coming in Phase 2</div>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            Two more strategies — <code>range-fade v1</code> and{" "}
            <code>breakout-confirm v1</code> — so the engine has an edge in every
            regime, not just trends.
          </li>
          <li>
            Regime router that picks the right strategy per symbol per tick.
          </li>
          <li>
            Per-strategy equity curve and rolling 30-trade Sharpe sparkline.
          </li>
        </ul>
        <Link
          to="/strategy"
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Open Strategy Lab
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}
