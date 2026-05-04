// ============================================================
// Edge Dashboard — Midnight Quant Desk redesign
// Adds: edge quality bars, grade badges, ops-center header,
// department-model section headers, agent attribution.
// All existing data logic preserved 100%.
// ============================================================

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight, BarChart3, Layers, Repeat, ShieldCheck,
  TrendingDown, TrendingUp, Users2,
} from "lucide-react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { EmptyState } from "@/components/trader/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ─── types (unchanged) ───────────────────────────────────────────────────────

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

// ─── helpers ─────────────────────────────────────────────────────────────────

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

// ─── Edge quality bar ─────────────────────────────────────────────────────────

function EdgeQualityBar({ winRate, trades }: { winRate: number | null; trades: number }) {
  if (!winRate || trades < 5) {
    return (
      <div className="flex items-center gap-2 min-w-[80px]">
        <div className="flex-1 h-1.5 rounded-full bg-secondary/60" />
        <span className="text-[10px] text-muted-foreground/50 tabular w-6 text-right">—</span>
      </div>
    );
  }
  const pct = winRate * 100;
  const fillClass = pct >= 60 ? "bg-status-safe" : pct >= 45 ? "bg-status-caution" : "bg-status-blocked";
  const textClass = pct >= 60 ? "text-status-safe" : pct >= 45 ? "text-status-caution" : "text-status-blocked";
  const label = pct >= 60 ? "strong" : pct >= 45 ? "ok" : "weak";

  return (
    <div className="flex flex-col gap-0.5 min-w-[80px]">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-secondary/60 overflow-hidden">
          <div className={cn("h-full rounded-full transition-all", fillClass)} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <span className={cn("text-[10px] tabular w-6 text-right font-medium", textClass)}>
          {pct.toFixed(0)}%
        </span>
      </div>
      <div className={cn("text-[9px] uppercase tracking-wider", textClass)}>{label}</div>
    </div>
  );
}

// ─── Strategy grade badge ─────────────────────────────────────────────────────

function StrategyGrade({ winRate, trades }: { winRate: number | null; trades: number }) {
  if (!winRate || trades < 5) return <span className="text-[11px] text-muted-foreground/40 font-mono font-bold">—</span>;
  const pct = winRate * 100;
  const grade = pct >= 65 ? "A" : pct >= 55 ? "B" : pct >= 45 ? "C" : pct >= 35 ? "D" : "F";
  const cls = pct >= 65 ? "text-status-safe" : pct >= 55 ? "text-primary" : pct >= 45 ? "text-status-caution" : "text-status-blocked";
  return <span className={cn("text-base font-bold font-mono", cls)}>{grade}</span>;
}

// ─── Status tone ──────────────────────────────────────────────────────────────

const STATUS_CLASSES: Record<string, string> = {
  approved: "bg-status-safe/10 text-status-safe border-status-safe/25",
  candidate:"bg-status-candidate/10 text-status-candidate border-status-candidate/25",
  paused:   "bg-status-blocked/10 text-status-blocked border-status-blocked/25",
  archived: "bg-secondary text-muted-foreground border-border",
};

// ─── page ─────────────────────────────────────────────────────────────────────

export default function Edge() {
  const [rows, setRows] = useState<StrategyRow[] | null>(null);
  const [metaById, setMetaById] = useState<Record<string, StrategyMeta>>({});
  const [ciById, setCiById] = useState<Record<string, StrategyCIRow>>({});
  const [recentRouter, setRecentRouter] = useState<RouterDecisionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);

  async function handleReplay(strategyId: string, strategyName: string) {
    setReplayingId(strategyId);
    try {
      const { data, error } = await supabase.functions.invoke("replay-strategy", {
        body: { strategy_id: strategyId, folds: 5, window_size: 30, window_step: 5 },
      });
      if (error) throw error;
      const verdict = (data as { verdict?: string })?.verdict ?? "n/a";
      const score = (data as { stability_score?: number | null })?.stability_score;
      const folds = ((data as { folds?: unknown[] })?.folds ?? []).length;
      const scoreStr = typeof score === "number" ? `${(score * 100).toFixed(0)}%` : "—";
      const tone = verdict === "stable_edge" ? "success" : verdict === "unstable_or_overfit" ? "error" : "info";
      const msg = `${strategyName}: ${verdict.replace(/_/g, " ")} · stability ${scoreStr} across ${folds} folds`;
      if (tone === "success") toast.success(msg);
      else if (tone === "error") toast.error(msg);
      else toast(msg);
    } catch (e) {
      toast.error(`Replay failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setReplayingId(null); }
  }

  const load = async () => {
    const [perfRes, metaRes, ciRes, sigRes] = await Promise.all([
      supabase.from("strategy_performance_v" as never).select("*").order("status", { ascending: true }).order("total_pnl", { ascending: false }),
      supabase.from("strategies").select("id, consecutive_losses, auto_paused_at, auto_pause_reason"),
      supabase.from("strategy_performance_ci_v" as never).select("*"),
      supabase.from("trade_signals").select("id, symbol, side, regime, created_at, context_snapshot").order("created_at", { ascending: false }).limit(10),
    ]);
    if (perfRes.error) { setError(perfRes.error.message); setRows([]); return; }
    setRows((perfRes.data ?? []) as unknown as StrategyRow[]);
    const metaMap: Record<string, StrategyMeta> = {};
    for (const m of (metaRes.data ?? []) as StrategyMeta[]) metaMap[m.id] = m;
    setMetaById(metaMap);
    const ciMap: Record<string, StrategyCIRow> = {};
    for (const c of ((ciRes.data ?? []) as unknown as StrategyCIRow[])) ciMap[c.strategy_id] = c;
    setCiById(ciMap);
    setRecentRouter((sigRes.data ?? []) as unknown as RouterDecisionRow[]);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => { await load(); })();
    return () => { cancelled = true; void cancelled; };
  }, []);

  const rearmStrategy = async (strategyId: string) => {
    setBusyId(strategyId);
    const { error: updErr } = await supabase.from("strategies").update({ status: "approved", consecutive_losses: 0, auto_paused_at: null, auto_pause_reason: null }).eq("id", strategyId);
    setBusyId(null);
    if (!updErr) await load();
  };

  const approved  = (rows ?? []).filter((r) => r.status === "approved");
  const totalWeight = approved.reduce((s, r) => s + Number(r.risk_weight ?? 0), 0);
  const portfolioPnl = (rows ?? []).reduce((s, r) => s + Number(r.total_pnl ?? 0), 0);
  const portfolioTrades = (rows ?? []).reduce((s, r) => s + Number(r.closed_trades ?? 0), 0);

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Intelligence"
        title="Edge"
        description="Per-strategy performance with confidence intervals, regime router decisions, and circuit-breaker status. Honest metrics or no metrics."
      />

      {/* Portfolio summary strip — Midnight Quant Desk style */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="panel p-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            <Layers className="h-3.5 w-3.5" />
            Approved strategies
          </div>
          <div className="text-2xl font-semibold font-mono text-foreground">{approved.length}</div>
          <div className="text-[11px] text-muted-foreground mt-1">
            {(rows ?? []).length} total · {portfolioTrades} closed trades
          </div>
        </div>
        <div className="panel p-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            <ShieldCheck className="h-3.5 w-3.5" />
            Total risk weight (approved)
          </div>
          <div className="text-2xl font-semibold font-mono text-foreground">{totalWeight.toFixed(2)}×</div>
          <div className="text-[11px] text-muted-foreground mt-1">Multiplier on doctrine risk-per-trade %</div>
        </div>
        <div className="panel p-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            {portfolioPnl >= 0
              ? <TrendingUp className="h-3.5 w-3.5 text-status-safe" />
              : <TrendingDown className="h-3.5 w-3.5 text-status-blocked" />
            }
            Portfolio realized PnL
          </div>
          <div className={cn("text-2xl font-semibold font-mono", portfolioPnl > 0 && "text-status-safe", portfolioPnl < 0 && "text-status-blocked")}>
            {fmtUsd(portfolioPnl)}
          </div>
          <div className="text-[11px] text-muted-foreground mt-1">Across all strategies</div>
        </div>
      </div>

      {/* Strategy roster — team lineup with grade badges + edge bars */}
      {rows === null ? (
        <div className="panel p-6 text-sm text-muted-foreground">Loading strategies…</div>
      ) : error ? (
        <div className="panel p-6 border-status-blocked/30 bg-status-blocked/5 text-sm text-status-blocked">
          Could not load strategies: {error}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No strategies yet" description="Once strategies are seeded you'll see per-strategy performance here." />
      ) : (
        <div className="panel overflow-hidden">
          {/* Section header */}
          <div className="px-4 py-3 border-b border-border bg-card/60 flex items-center justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Strategy desk — team roster</div>
              <div className="text-sm font-medium text-foreground mt-0.5">
                {approved.length} starter{approved.length !== 1 ? "s" : ""} · {(rows ?? []).filter(r => r.status === "candidate").length} prospect{(rows ?? []).filter(r => r.status === "candidate").length !== 1 ? "s" : ""}
              </div>
            </div>
            <Link to="/strategy" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
              Open Strategy Lab <ArrowUpRight className="h-3 w-3" />
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-secondary/20 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 text-left font-semibold">Strategy</th>
                  <th className="px-4 py-2.5 text-center font-semibold">Grade</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Edge quality</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Regime fit</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Trades</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Win rate</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Total PnL</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Avg %</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Last close</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const pnl = Number(r.total_pnl ?? 0);
                  const avgPct = Number(r.avg_pnl_pct ?? 0);
                  const meta = metaById[r.strategy_id];
                  // role label
                  const roleLabel = r.status === "approved" ? "Starter" : r.status === "candidate" ? "Prospect" : "Alumni";

                  return (
                    <tr key={r.strategy_id} className="hover:bg-secondary/20 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-foreground">{r.strategy_name}</span>
                            <Badge variant="outline" className={cn("text-[9px] uppercase tracking-wider font-semibold", STATUS_CLASSES[r.status] ?? STATUS_CLASSES.archived)}>
                              {roleLabel}
                            </Badge>
                            {meta?.auto_paused_at && (
                              <button type="button" disabled={busyId === r.strategy_id} onClick={() => rearmStrategy(r.strategy_id)} className="text-[10px] font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50">
                                {busyId === r.strategy_id ? "re-arming…" : "re-arm"}
                              </button>
                            )}
                          </div>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {r.strategy_version}
                            {(meta?.consecutive_losses ?? 0) > 0 && (
                              <span className="ml-2 text-status-caution">· {meta.consecutive_losses} loss streak</span>
                            )}
                            {meta?.auto_pause_reason && (
                              <span className="ml-2 text-status-blocked">· {meta.auto_pause_reason}</span>
                            )}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <StrategyGrade winRate={r.win_rate} trades={r.closed_trades} />
                      </td>
                      <td className="px-4 py-3">
                        <EdgeQualityBar winRate={r.win_rate} trades={r.closed_trades} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {(r.regime_affinity ?? []).length === 0 ? (
                            <span className="text-xs text-muted-foreground">any</span>
                          ) : (
                            (r.regime_affinity ?? []).map((reg) => (
                              <Badge key={reg} variant="outline" className="text-[9px] font-normal">{reg}</Badge>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {r.closed_trades}
                        {r.wins + r.losses > 0 && (
                          <span className="ml-1 text-muted-foreground">({r.wins}W/{r.losses}L)</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{fmtPct(r.win_rate, 0)}</td>
                      <td className={cn("px-4 py-3 text-right font-mono text-xs", pnl > 0 && "text-status-safe", pnl < 0 && "text-status-blocked")}>
                        {fmtUsd(pnl)}
                      </td>
                      <td className={cn("px-4 py-3 text-right font-mono text-xs", avgPct > 0 && "text-status-safe", avgPct < 0 && "text-status-blocked")}>
                        {avgPct === 0 ? "—" : `${avgPct > 0 ? "+" : ""}${avgPct.toFixed(2)}%`}
                      </td>
                      <td className="px-4 py-3 text-right text-[11px] text-muted-foreground">{fmtAgo(r.last_closed_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Grade key */}
          <div className="px-4 py-2 border-t border-border bg-secondary/10 flex items-center gap-4 text-[10px] flex-wrap">
            <span className="text-muted-foreground">Grade key:</span>
            <span className="text-status-safe font-mono font-bold">A</span><span className="text-muted-foreground">≥65% win</span>
            <span className="text-primary font-mono font-bold">B</span><span className="text-muted-foreground">55–64%</span>
            <span className="text-status-caution font-mono font-bold">C</span><span className="text-muted-foreground">45–54%</span>
            <span className="text-status-blocked font-mono font-bold">D/F</span><span className="text-muted-foreground">&lt;45% — retire</span>
          </div>
        </div>
      )}

      {/* Statistical honesty panel */}
      <div className="panel">
        <div className="border-b border-border px-4 py-3 flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <div>
            <div className="text-sm font-medium">Statistical honesty</div>
            <div className="text-xs text-muted-foreground">95% CIs on every metric. Fewer than 30 closed trades = "unproven" — point estimates lie.</div>
          </div>
        </div>
        {(rows ?? []).length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">No strategies to evaluate yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-secondary/20 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 text-left font-semibold">Strategy</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Evidence</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Win rate (95% CI)</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Expectancy $ (95% CI)</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Sharpe</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Verdict</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Replay</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(rows ?? []).map((r) => {
                  const ci = ciById[r.strategy_id];
                  const ev = ci?.evidence_status ?? "no_data";
                  const verdict = ci?.edge_verdict ?? "unproven";
                  const evTone = ev === "sufficient" ? "text-status-safe border-status-safe/30" : ev === "developing" ? "text-status-caution border-status-caution/30" : "text-muted-foreground border-border";
                  const verdictTone = verdict === "positive_edge" ? "bg-status-safe/10 text-status-safe border-status-safe/30" : verdict === "negative_edge" ? "bg-status-blocked/10 text-status-blocked border-status-blocked/30" : verdict === "inconclusive" ? "bg-status-caution/10 text-status-caution border-status-caution/30" : "bg-secondary text-muted-foreground border-border";
                  const fmtCi = (lo: number | null | undefined, hi: number | null | undefined, fmt: (n: number) => string) =>
                    lo == null || hi == null ? "—" : `[${fmt(lo)}, ${fmt(hi)}]`;
                  return (
                    <tr key={`ci-${r.strategy_id}`} className="hover:bg-secondary/20 transition-colors">
                      <td className="px-4 py-3">
                        <span className="font-medium text-foreground">{r.strategy_name}</span>{" "}
                        <span className="text-[10px] text-muted-foreground font-mono">{r.strategy_version}</span>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={cn("text-[9px]", evTone)}>{ev.replace(/_/g, " ")}</Badge>
                        <span className="ml-2 text-[10px] text-muted-foreground font-mono">n={ci?.closed_trades ?? 0}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        <div>{fmtPct(ci?.win_rate, 0)}</div>
                        <div className="text-[10px] text-muted-foreground">{fmtCi(ci?.win_rate_lo, ci?.win_rate_hi, (n) => `${(n * 100).toFixed(0)}%`)}</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        <div>{fmtUsd(ci?.avg_pnl)}</div>
                        <div className="text-[10px] text-muted-foreground">{fmtCi(ci?.avg_pnl_lo, ci?.avg_pnl_hi, (n) => fmtUsd(n))}</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        <div>{ci?.sharpe == null ? "—" : ci.sharpe.toFixed(2)}</div>
                        <div className="text-[10px] text-muted-foreground">{fmtCi(ci?.sharpe_lo, ci?.sharpe_hi, (n) => n.toFixed(2))}</div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={cn("text-[9px] uppercase tracking-wide", verdictTone)}>{verdict.replace(/_/g, " ")}</Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={replayingId === r.strategy_id || (ci?.closed_trades ?? 0) < 30} onClick={() => handleReplay(r.strategy_id, r.strategy_name)} title={(ci?.closed_trades ?? 0) < 30 ? "Need 30+ closed trades to replay" : "Walk-forward replay"}>
                          <Repeat className="h-3 w-3 mr-1" />
                          {replayingId === r.strategy_id ? "Replaying…" : "Replay"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-border bg-secondary/10 px-4 py-2 text-[10px] text-muted-foreground">
          Methodology: Wilson score interval on win-rate, t-based 95% CI on expectancy, Lo (2002) SE on per-trade Sharpe. "Positive edge" requires lower bound of expectancy above $0.
        </div>
      </div>

      {/* Recent router decisions */}
      <div className="panel">
        <div className="border-b border-border px-4 py-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-foreground">Recent router decisions</div>
            <div className="text-xs text-muted-foreground">Last 10 signals · which strategy fired and why</div>
          </div>
          <Link to="/company" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
            <Users2 className="h-3.5 w-3.5" /> Agent roster →
          </Link>
        </div>
        {recentRouter.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">No signals yet. The router will log its picks here as they fire.</div>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {recentRouter.map((s) => {
              const rd = s.context_snapshot?.routerDecision;
              const synth = s.context_snapshot?.syntheticShort;
              return (
                <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 hover:bg-secondary/20 transition-colors">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-foreground">{s.symbol}</span>
                      <Badge variant="outline" className={cn("text-[9px] uppercase", s.side === "long" ? "text-status-safe border-status-safe/30" : "text-status-blocked border-status-blocked/30")}>{s.side}</Badge>
                      <Badge variant="outline" className="text-[9px]">{s.regime}</Badge>
                      {synth && <Badge variant="outline" className="text-[9px] text-status-caution border-status-caution/30">synthetic short</Badge>}
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      {rd?.chosenStrategyName ? `→ ${rd.chosenStrategyName} v${rd.chosenStrategyVersion}: ${rd.reason}` : "no router decision recorded"}
                    </span>
                  </div>
                  <span className="text-[11px] text-muted-foreground font-mono">{fmtAgo(s.created_at)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

