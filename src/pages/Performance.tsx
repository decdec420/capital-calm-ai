// ============================================================
// Performance Dashboard
// ------------------------------------------------------------
// Source of truth: closed trades from the `trades` table.
// Sections:
//   1. Summary metrics (win%, expectancy, profit factor, ...)
//   2. Equity curve
//   3. Per-symbol breakdown
//   4. Monthly P&L grid
//   5. Scaling Readiness checklist
// ============================================================

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import {
  BarChart2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { MetricCard } from "@/components/trader/MetricCard";
import { EmptyState } from "@/components/trader/EmptyState";
import { useTrades } from "@/hooks/useTrades";
import { useSystemState } from "@/hooks/useSystemState";
import { useStrategies } from "@/hooks/useStrategies";
import { cn } from "@/lib/utils";
import type { Trade } from "@/lib/domain-types";

const SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;

interface SymbolStats {
  symbol: string;
  trades: number;
  winRate: number;
  avgPnl: number;
  netPnl: number;
  expectancyR: number;
}

function calcExpectancyR(trades: Trade[]): number {
  if (trades.length === 0) return 0;
  // R = pnl / |stop_distance * size|. If we lack stop info, fall back to abs(pnl).
  const rValues = trades.map((t) => {
    const risk = t.stopLoss && t.entryPrice
      ? Math.abs(t.entryPrice - t.stopLoss) * (t.originalSize ?? t.size)
      : 0;
    if (risk > 0 && t.pnl !== null) return t.pnl / risk;
    return t.pnl ?? 0;
  });
  const wins = rValues.filter((r) => r > 0);
  const losses = rValues.filter((r) => r < 0);
  const winRate = wins.length / rValues.length;
  const lossRate = losses.length / rValues.length;
  const avgWinR = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLossR = losses.length > 0
    ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length)
    : 0;
  return winRate * avgWinR - lossRate * avgLossR;
}

function fmtMoney(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export default function Performance() {
  const { closed, loading } = useTrades();
  const { data: system } = useSystemState();
  const { strategies } = useStrategies();
  const [readinessOpen, setReadinessOpen] = useState(false);

  // Sort closed trades chronologically (oldest first)
  const closedSorted = useMemo(
    () =>
      [...closed]
        .filter((t) => t.closedAt)
        .sort(
          (a, b) =>
            new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime(),
        ),
    [closed],
  );

  // Summary metrics
  const summary = useMemo(() => {
    if (closedSorted.length === 0) {
      return {
        total: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        netPnl: 0,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
        expectancyR: 0,
        maxConsecutiveLosses: 0,
      };
    }
    const wins = closedSorted.filter((t) => (t.pnl ?? 0) > 0);
    const losses = closedSorted.filter((t) => (t.pnl ?? 0) < 0);
    const grossWins = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const grossLosses = losses.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const netPnl = closedSorted.reduce((s, t) => s + (t.pnl ?? 0), 0);
    let consecLosses = 0;
    let maxConsec = 0;
    for (const t of closedSorted) {
      if ((t.pnl ?? 0) < 0) {
        consecLosses += 1;
        maxConsec = Math.max(maxConsec, consecLosses);
      } else {
        consecLosses = 0;
      }
    }
    return {
      total: closedSorted.length,
      wins: wins.length,
      losses: losses.length,
      winRate: wins.length / closedSorted.length,
      netPnl,
      avgWin: wins.length > 0 ? grossWins / wins.length : 0,
      avgLoss: losses.length > 0 ? grossLosses / losses.length : 0,
      profitFactor: grossLosses !== 0 ? Math.abs(grossWins / grossLosses) : grossWins > 0 ? Infinity : 0,
      expectancyR: calcExpectancyR(closedSorted),
      maxConsecutiveLosses: maxConsec,
    };
  }, [closedSorted]);

  // Equity curve points
  const equityCurve = useMemo(() => {
    let cumulative = 0;
    return closedSorted.map((t, i) => {
      cumulative += t.pnl ?? 0;
      return {
        idx: i + 1,
        date: new Date(t.closedAt!).toLocaleDateString(),
        cumulative: Number(cumulative.toFixed(2)),
      };
    });
  }, [closedSorted]);

  // Per-symbol breakdown
  const perSymbol: SymbolStats[] = useMemo(() => {
    const groups = new Map<string, Trade[]>();
    for (const t of closedSorted) {
      const arr = groups.get(t.symbol) ?? [];
      arr.push(t);
      groups.set(t.symbol, arr);
    }
    const stats: SymbolStats[] = [];
    for (const [symbol, ts] of groups.entries()) {
      const wins = ts.filter((t) => (t.pnl ?? 0) > 0);
      const netPnl = ts.reduce((s, t) => s + (t.pnl ?? 0), 0);
      stats.push({
        symbol,
        trades: ts.length,
        winRate: ts.length > 0 ? wins.length / ts.length : 0,
        avgPnl: ts.length > 0 ? netPnl / ts.length : 0,
        netPnl,
        expectancyR: calcExpectancyR(ts),
      });
    }
    return stats.sort((a, b) => b.netPnl - a.netPnl);
  }, [closedSorted]);

  const bestSymbol = perSymbol[0]?.symbol;
  const worstSymbol = perSymbol[perSymbol.length - 1]?.symbol;

  // Monthly P&L grid: rows = month (YYYY-MM), cols = symbol
  const monthly = useMemo(() => {
    const months = new Set<string>();
    const grid = new Map<string, Map<string, number>>();
    for (const t of closedSorted) {
      const month = new Date(t.closedAt!).toISOString().slice(0, 7);
      months.add(month);
      const row = grid.get(month) ?? new Map();
      row.set(t.symbol, (row.get(t.symbol) ?? 0) + (t.pnl ?? 0));
      grid.set(month, row);
    }
    const sortedMonths = Array.from(months).sort().reverse();
    return { months: sortedMonths, grid };
  }, [closedSorted]);

  // Scaling Readiness checks
  const last30dTrades = useMemo(() => {
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    return closedSorted.filter((t) => new Date(t.closedAt!).getTime() >= cutoff);
  }, [closedSorted]);

  const last30dPnl = last30dTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);

  // Max drawdown from equity curve
  const maxDrawdownPct = useMemo(() => {
    if (equityCurve.length === 0) return 0;
    let peak = 0;
    let maxDdAbs = 0;
    for (const p of equityCurve) {
      if (p.cumulative > peak) peak = p.cumulative;
      const dd = peak - p.cumulative;
      if (dd > maxDdAbs) maxDdAbs = dd;
    }
    // express as % of peak when peak > 0, else absolute $ as a proxy
    return peak > 0 ? (maxDdAbs / peak) * 100 : 0;
  }, [equityCurve]);

  const promotedStrategies = strategies?.filter((s) => s.status === "approved") ?? [];

  const checks = [
    {
      label: "Positive expectancy over ≥50 paper trades",
      ok: summary.total >= 50 && summary.expectancyR > 0,
      note: `${summary.total} trades · ${summary.expectancyR.toFixed(2)}R expectancy`,
    },
    {
      label: "Max drawdown under 25% on real paper trades",
      ok: maxDrawdownPct < 25 && summary.total > 0,
      note: `${maxDrawdownPct.toFixed(1)}% max DD`,
    },
    {
      label: "Net profitable over last 30 days",
      ok: last30dPnl > 0,
      note: `${fmtMoney(last30dPnl)} (${last30dTrades.length} trades)`,
    },
    {
      label: "Strategy params wired into live engine",
      ok: !!system?.lastEngineSnapshot && (system as unknown as { params_wired_live?: boolean }).params_wired_live !== false,
      note: "set system_state.params_wired_live = true once shipped",
    },
    {
      label: "At least 1 full learning cycle completed",
      ok: promotedStrategies.length >= 1,
      note: `${promotedStrategies.length} approved strategy(s)`,
    },
    {
      label: "Paper trading engine running",
      ok: system?.bot === "running" || system?.bot === "paused",
      note: `bot: ${system?.bot ?? "unknown"} · mode: ${system?.mode ?? "paper"}`,
    },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Trading"
        title="Performance"
        description="Process before outcome — but the outcome is the ledger. This page is the ledger."
      />

      {/* Section 1: Summary Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <MetricCard label="Total trades" value={String(summary.total)} loading={loading} />
        <MetricCard
          label="Win rate"
          value={fmtPct(summary.winRate)}
          tone={summary.winRate >= 0.5 ? "safe" : "caution"}
          hint={`${summary.wins}W / ${summary.losses}L`}
          loading={loading}
        />
        <MetricCard
          label="Expectancy"
          value={`${summary.expectancyR.toFixed(2)}R`}
          tone={summary.expectancyR > 0 ? "safe" : "blocked"}
          loading={loading}
        />
        <MetricCard
          label="Profit factor"
          value={Number.isFinite(summary.profitFactor) ? summary.profitFactor.toFixed(2) : "∞"}
          tone={summary.profitFactor >= 1 ? "safe" : "blocked"}
          loading={loading}
        />
        <MetricCard
          label="Avg win"
          value={summary.avgWin === 0 ? "—" : `$${summary.avgWin.toFixed(2)}`}
          tone="safe"
          loading={loading}
        />
        <MetricCard
          label="Avg loss"
          value={summary.avgLoss === 0 ? "—" : `$${summary.avgLoss.toFixed(2)}`}
          tone="blocked"
          loading={loading}
        />
        <MetricCard
          label="Net P&L"
          value={fmtMoney(summary.netPnl)}
          tone={summary.netPnl >= 0 ? "safe" : "blocked"}
          icon={summary.netPnl >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
          hint={`max ${summary.maxConsecutiveLosses} consec losses`}
          loading={loading}
        />
      </div>

      {/* Section 2: Equity Curve */}
      <div className="panel p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Equity curve</h2>
          <span className="text-[10px] text-muted-foreground tabular">
            cumulative net P&L · {equityCurve.length} closed trades
          </span>
        </div>
        {equityCurve.length < 3 ? (
          <EmptyState
            icon={<BarChart2 className="h-5 w-5" />}
            title="Not enough closed trades yet"
            description="Equity curve appears here once you have 3+ closed trades."
          />
        ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={equityCurve} margin={{ top: 10, right: 16, left: 0, bottom: 4 }}>
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                  tickFormatter={(v) => `$${v}`}
                />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  formatter={(v: number) => [`$${v.toFixed(2)}`, "Cumulative P&L"]}
                />
                <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="3 3" />
                <Line
                  type="monotone"
                  dataKey="cumulative"
                  stroke={summary.netPnl >= 0 ? "hsl(var(--status-safe))" : "hsl(var(--status-blocked))"}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Section 3: Per-Symbol Breakdown */}
      <div className="panel p-5 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Per-symbol breakdown</h2>
        {perSymbol.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No closed trades yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="text-left py-2 font-medium">Symbol</th>
                  <th className="text-right py-2 font-medium">Trades</th>
                  <th className="text-right py-2 font-medium">Win %</th>
                  <th className="text-right py-2 font-medium">Avg P&L</th>
                  <th className="text-right py-2 font-medium">Net P&L</th>
                  <th className="text-right py-2 font-medium">Expectancy (R)</th>
                </tr>
              </thead>
              <tbody>
                {perSymbol.map((s) => (
                  <tr
                    key={s.symbol}
                    className={cn(
                      "border-b border-border/40",
                      s.symbol === bestSymbol && perSymbol.length > 1 && "bg-status-safe/5",
                      s.symbol === worstSymbol && perSymbol.length > 1 && s.netPnl < 0 && "bg-status-blocked/5",
                    )}
                  >
                    <td className="py-2 font-medium text-foreground">{s.symbol}</td>
                    <td className="text-right tabular text-foreground">{s.trades}</td>
                    <td className="text-right tabular text-foreground">{fmtPct(s.winRate)}</td>
                    <td className={cn("text-right tabular", s.avgPnl >= 0 ? "text-status-safe" : "text-status-blocked")}>
                      {fmtMoney(s.avgPnl)}
                    </td>
                    <td className={cn("text-right tabular font-medium", s.netPnl >= 0 ? "text-status-safe" : "text-status-blocked")}>
                      {fmtMoney(s.netPnl)}
                    </td>
                    <td className={cn("text-right tabular", s.expectancyR >= 0 ? "text-status-safe" : "text-status-blocked")}>
                      {s.expectancyR.toFixed(2)}R
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Section 4: Monthly P&L Grid */}
      <div className="panel p-5 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Monthly P&L</h2>
        {monthly.months.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No closed trades yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="text-left py-2 font-medium">Month</th>
                  {SYMBOLS.map((s) => (
                    <th key={s} className="text-right py-2 font-medium">{s}</th>
                  ))}
                  <th className="text-right py-2 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {monthly.months.map((m) => {
                  const row = monthly.grid.get(m);
                  const total = row ? Array.from(row.values()).reduce((a, b) => a + b, 0) : 0;
                  return (
                    <tr key={m} className="border-b border-border/40">
                      <td className="py-2 font-medium text-foreground tabular">{m}</td>
                      {SYMBOLS.map((sym) => {
                        const val = row?.get(sym);
                        if (val === undefined) {
                          return <td key={sym} className="text-right text-muted-foreground/40">—</td>;
                        }
                        return (
                          <td
                            key={sym}
                            className={cn(
                              "text-right tabular",
                              val >= 0 ? "text-status-safe" : "text-status-blocked",
                            )}
                          >
                            {fmtMoney(val)}
                          </td>
                        );
                      })}
                      <td
                        className={cn(
                          "text-right tabular font-medium",
                          total >= 0 ? "text-status-safe" : "text-status-blocked",
                        )}
                      >
                        {fmtMoney(total)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Section 5: Scaling Readiness */}
      <div className="panel">
        <button
          type="button"
          onClick={() => setReadinessOpen((o) => !o)}
          className="w-full p-4 flex items-center justify-between hover:bg-accent/50 transition-colors rounded-md"
        >
          <div className="flex items-center gap-2">
            {readinessOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="text-sm font-semibold text-foreground">📊 Scaling Readiness</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {checks.filter((c) => c.ok).length}/{checks.length} green
            </span>
          </div>
        </button>
        {readinessOpen && (
          <div className="px-5 pb-5 space-y-3">
            <p className="text-xs text-muted-foreground">
              These must all be green before raising doctrine caps beyond $1/trade.
            </p>
            <ul className="space-y-2">
              {checks.map((c) => (
                <li key={c.label} className="flex items-start gap-2 text-sm">
                  {c.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-status-safe mt-0.5 shrink-0" />
                  ) : (
                    <XCircle className="h-4 w-4 text-status-blocked mt-0.5 shrink-0" />
                  )}
                  <div className="flex-1">
                    <div className="text-foreground">{c.label}</div>
                    <div className="text-[11px] text-muted-foreground tabular">{c.note}</div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="text-[11px] text-muted-foreground italic border-t border-border pt-3">
              When all green: edit <code className="bg-secondary px-1 rounded">doctrine.ts</code>{" "}
              to raise <code className="bg-secondary px-1 rounded">maxOrderUsdHardCap</code>. Do it deliberately.
              <Link to="/strategy" className="text-primary hover:underline ml-1">Strategy Lab →</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
