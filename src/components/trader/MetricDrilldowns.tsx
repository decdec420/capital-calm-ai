import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  DollarSign,
  Info,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { MetricDrilldownSheet, DrilldownSection, DrilldownStat } from "./MetricDrilldownSheet";
import { StatusBadge } from "./StatusBadge";
import { Button } from "@/components/ui/button";
import type { AccountState, Trade, SystemState, TradeSignal } from "@/lib/domain-types";
import { DOCTRINE } from "@/lib/doctrine-constants";
import { cn } from "@/lib/utils";

export type DrilldownKind =
  | "equity"
  | "dailyPnl"
  | "tradesToday"
  | "lossVsCap"
  | "floorDistance"
  | "liveMode";

interface MetricDrilldownsProps {
  open: DrilldownKind | null;
  onOpenChange: (k: DrilldownKind | null) => void;
  account: AccountState | null;
  system: SystemState | null;
  open_: Trade[];
  closed: Trade[];
  closedToday: Trade[];
  realizedToday: number;
  unrealizedToday: number;
  dailyPnl: number;
  dailyPnlPct: number;
  lossToday: number;
  lossVsCap: number;
  floorDistance: number;
  pendingSignals?: TradeSignal[];
}

export function MetricDrilldowns(props: MetricDrilldownsProps) {
  const { open, onOpenChange } = props;
  const close = () => onOpenChange(null);

  return (
    <>
      <EquityDrilldown {...props} open={open === "equity"} onClose={close} />
      <DailyPnlDrilldown {...props} open={open === "dailyPnl"} onClose={close} />
      <TradesTodayDrilldown {...props} open={open === "tradesToday"} onClose={close} />
      <LossVsCapDrilldown {...props} open={open === "lossVsCap"} onClose={close} />
      <FloorDistanceDrilldown {...props} open={open === "floorDistance"} onClose={close} />
      <LiveModeDrilldown {...props} open={open === "liveMode"} onClose={close} />
    </>
  );
}

type Common = Omit<MetricDrilldownsProps, "open" | "onOpenChange"> & {
  open: boolean;
  onClose: () => void;
};

const PAPER_BASELINE = 1000;

function fmtMoney(n: number, opts: Intl.NumberFormatOptions = {}) {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...opts,
  });
}

function fmtMoneyAdaptive(n: number) {
  const abs = Math.abs(n);
  const digits = abs < 1 ? 4 : 2;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function rMultiple(t: Trade): number | null {
  if (t.pnl == null || t.stopLoss == null) return null;
  const stopDist = Math.abs(t.entryPrice - t.stopLoss) * t.size;
  if (stopDist <= 0) return null;
  return t.pnl / stopDist;
}

// ════════════════════════════════════════════════════════════════════════════
// EQUITY DRILLDOWN
// ════════════════════════════════════════════════════════════════════════════

function EquityDrilldown({ open, onClose, account, open_, closed }: Common) {
  // Build a real timestamped equity curve from closed trades.
  const chartData = useMemo(() => {
    if (!account) return [] as Array<{ t: string; equity: number; pnl: number; label: string }>;
    const sorted = [...closed]
      .filter((t) => t.closedAt)
      .sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime());
    const startEquity = account.equity - sorted.reduce((s, t) => s + (t.pnl ?? 0), 0);
    let running = startEquity;
    const data: Array<{ t: string; equity: number; pnl: number; label: string }> = [
      { t: sorted[0]?.closedAt ?? new Date().toISOString(), equity: startEquity, pnl: 0, label: "Start" },
    ];
    for (const t of sorted) {
      running += t.pnl ?? 0;
      data.push({
        t: t.closedAt!,
        equity: running,
        pnl: t.pnl ?? 0,
        label: shortDate(t.closedAt!),
      });
    }
    return data;
  }, [account, closed]);

  const startOfDayEquity = account?.startOfDayEquity ?? 0;
  const lastEquity = chartData[chartData.length - 1]?.equity ?? account?.equity ?? 0;
  const lineTone = lastEquity >= startOfDayEquity ? "hsl(var(--status-safe))" : "hsl(var(--status-blocked))";

  const openMTM = open_.reduce((s, t) => s + (t.unrealizedPnl ?? 0), 0);
  const openMarketValue = open_.reduce((s, t) => s + (t.currentPrice ?? t.entryPrice) * t.size, 0);

  // All-time stats from the full closed array.
  const stats = useMemo(() => {
    const winners = closed.filter((t) => (t.pnl ?? 0) > 0);
    const losers = closed.filter((t) => (t.pnl ?? 0) < 0);
    const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const winRate = closed.length > 0 ? (winners.length / closed.length) * 100 : 0;
    const avgWin = winners.length > 0
      ? winners.reduce((s, t) => s + (t.pnl ?? 0), 0) / winners.length
      : 0;
    const avgLoss = losers.length > 0
      ? losers.reduce((s, t) => s + (t.pnl ?? 0), 0) / losers.length
      : 0;
    // Expectancy in R: average pnl / avg loss magnitude (fallback). Best-effort.
    const rs = closed.map((t) => rMultiple(t)).filter((x): x is number => x != null);
    const expectancyR = rs.length > 0
      ? rs.reduce((s, r) => s + r, 0) / rs.length
      : avgLoss !== 0
        ? totalPnl / closed.length / Math.abs(avgLoss)
        : 0;
    const best = winners.reduce<Trade | null>(
      (b, t) => (b && (b.pnl ?? 0) > (t.pnl ?? 0) ? b : t),
      null,
    );
    const worst = losers.reduce<Trade | null>(
      (w, t) => (w && (w.pnl ?? 0) < (t.pnl ?? 0) ? w : t),
      null,
    );
    return {
      totalTrades: closed.length,
      winRate,
      expectancyR,
      avgWin,
      avgLoss,
      best,
      worst,
      totalPnl,
    };
  }, [closed]);

  const paperFinal = PAPER_BASELINE + stats.totalPnl;
  const paperPctChange = ((paperFinal - PAPER_BASELINE) / PAPER_BASELINE) * 100;

  return (
    <MetricDrilldownSheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={
        <span className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-primary" />
          Equity breakdown
        </span>
      }
      description={account ? `Total account value across cash + open positions.` : undefined}
    >
      {!account ? (
        <p className="text-sm text-muted-foreground italic">No account state yet.</p>
      ) : (
        <>
          <div className="rounded-md border border-border bg-background/40 p-4 space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Equity now
              </span>
              <span className="text-2xl tabular font-semibold text-foreground">
                ${fmtMoney(account.equity)}
              </span>
            </div>

            {chartData.length < 3 ? (
              <div className="h-[160px] rounded-md border border-dashed border-border flex items-center justify-center">
                <p className="text-xs text-muted-foreground italic">
                  Equity curve builds as trades close.
                </p>
              </div>
            ) : (
              <div className="h-[160px] -mx-2">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                      tickLine={false}
                      axisLine={{ stroke: "hsl(var(--border))" }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                      tickLine={false}
                      axisLine={{ stroke: "hsl(var(--border))" }}
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                      width={56}
                    />
                    <RTooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 6,
                        fontSize: 11,
                      }}
                      formatter={(value: number, name: string) => {
                        if (name === "equity") return [`$${value.toFixed(4)}`, "Equity"];
                        return [value, name];
                      }}
                      labelFormatter={(label, payload) => {
                        const pnl = (payload?.[0]?.payload as { pnl?: number })?.pnl ?? 0;
                        const pnlStr = pnl !== 0 ? ` · trade ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}` : "";
                        return `${label}${pnlStr}`;
                      }}
                    />
                    <ReferenceLine
                      y={startOfDayEquity}
                      stroke="hsl(var(--muted-foreground))"
                      strokeDasharray="4 4"
                      label={{
                        value: "Start of day",
                        fontSize: 9,
                        fill: "hsl(var(--muted-foreground))",
                        position: "insideTopLeft",
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="equity"
                      stroke={lineTone}
                      strokeWidth={1.75}
                      dot={false}
                      activeDot={{ r: 3 }}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <DrilldownSection title="Composition">
            <div className="grid grid-cols-2 gap-2">
              <DrilldownStat label="Cash" value={`$${fmtMoney(account.cash)}`} />
              <DrilldownStat
                label="Open positions (mkt)"
                value={`$${fmtMoney(openMarketValue)}`}
              />
              <DrilldownStat
                label="Unrealized PnL"
                value={`${openMTM >= 0 ? "+" : ""}$${fmtMoney(openMTM)}`}
                tone={openMTM >= 0 ? "safe" : "blocked"}
              />
              <DrilldownStat
                label="Start-of-day equity"
                value={`$${fmtMoney(account.startOfDayEquity)}`}
              />
            </div>
          </DrilldownSection>

          <DrilldownSection title="All-time stats">
            <div className="grid grid-cols-2 gap-2">
              <DrilldownStat label="Total trades" value={String(stats.totalTrades)} />
              <DrilldownStat
                label="Win rate"
                value={stats.totalTrades > 0 ? `${stats.winRate.toFixed(1)}%` : "—"}
                tone={stats.winRate >= 50 ? "safe" : stats.totalTrades === 0 ? "default" : "caution"}
              />
              <DrilldownStat
                label="Expectancy"
                value={
                  stats.totalTrades > 0
                    ? `${stats.expectancyR >= 0 ? "+" : ""}${stats.expectancyR.toFixed(2)}R`
                    : "—"
                }
                tone={stats.expectancyR > 0 ? "safe" : stats.totalTrades === 0 ? "default" : "blocked"}
              />
              <DrilldownStat
                label="Avg win / loss"
                value={
                  stats.totalTrades > 0
                    ? `+$${fmtMoneyAdaptive(stats.avgWin)} / $${fmtMoneyAdaptive(stats.avgLoss)}`
                    : "—"
                }
              />
              {stats.best && (
                <DrilldownStat
                  label="Best trade"
                  value={`+$${fmtMoneyAdaptive(stats.best.pnl ?? 0)} · ${stats.best.symbol}`}
                  tone="safe"
                />
              )}
              {stats.worst && (
                <DrilldownStat
                  label="Worst trade"
                  value={`$${fmtMoneyAdaptive(stats.worst.pnl ?? 0)} · ${stats.worst.symbol}`}
                  tone="blocked"
                />
              )}
            </div>
          </DrilldownSection>

          <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-primary">
              Performance vs. paper baseline
            </div>
            <div className="mt-1 text-sm tabular text-foreground">
              ${fmtMoney(PAPER_BASELINE)} →{" "}
              <span className="font-medium">${fmtMoney(paperFinal)}</span>{" "}
              <span
                className={cn(
                  "ml-1",
                  paperPctChange >= 0 ? "text-status-safe" : "text-status-blocked",
                )}
              >
                ({paperPctChange >= 0 ? "+" : ""}
                {paperPctChange.toFixed(2)}%)
              </span>
            </div>
          </div>

          <DrilldownSection title="Floor">
            <DrilldownStat
              label={`Distance to floor ($${fmtMoney(account.balanceFloor)})`}
              value={`$${fmtMoney(account.equity - account.balanceFloor)} (${(((account.equity - account.balanceFloor) / account.equity) * 100).toFixed(1)}%)`}
              tone={account.equity - account.balanceFloor > 0 ? "safe" : "blocked"}
            />
          </DrilldownSection>

          <div className="flex gap-2 pt-2">
            <Button variant="outline" size="sm" asChild className="flex-1">
              <Link to="/trades" onClick={onClose}>
                View trades <ArrowRight className="h-3.5 w-3.5 ml-1" />
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild className="flex-1">
              <Link to="/risk" onClick={onClose}>
                Risk center <ArrowRight className="h-3.5 w-3.5 ml-1" />
              </Link>
            </Button>
          </div>
        </>
      )}
    </MetricDrilldownSheet>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// DAILY PNL DRILLDOWN
// ════════════════════════════════════════════════════════════════════════════

function DailyPnlDrilldown({
  open,
  onClose,
  closedToday,
  realizedToday,
  unrealizedToday,
  dailyPnl,
  dailyPnlPct,
}: Common) {
  const winners = closedToday.filter((t) => (t.pnl ?? 0) > 0);
  const losers = closedToday.filter((t) => (t.pnl ?? 0) < 0);

  // Per-symbol attribution.
  const bySymbol = useMemo(() => {
    const map = new Map<string, { trades: number; pnl: number; wins: number }>();
    for (const t of closedToday) {
      const cur = map.get(t.symbol) ?? { trades: 0, pnl: 0, wins: 0 };
      cur.trades += 1;
      cur.pnl += t.pnl ?? 0;
      if ((t.pnl ?? 0) > 0) cur.wins += 1;
      map.set(t.symbol, cur);
    }
    return Array.from(map.entries())
      .map(([symbol, s]) => ({ symbol, ...s, winRate: (s.wins / s.trades) * 100 }))
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  }, [closedToday]);

  return (
    <MetricDrilldownSheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={
        <span className="flex items-center gap-2">
          {dailyPnl >= 0 ? (
            <TrendingUp className="h-4 w-4 text-status-safe" />
          ) : (
            <TrendingDown className="h-4 w-4 text-status-blocked" />
          )}
          Daily PnL
        </span>
      }
      description="Profit & loss since this morning's start-of-day equity snapshot."
    >
      <div className="rounded-md border border-border bg-background/40 p-4">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Total today
          </div>
          {closedToday.length > 0 && (
            <StatusBadge
              tone={winners.length > losers.length ? "safe" : winners.length === losers.length ? "neutral" : "blocked"}
              size="sm"
            >
              {winners.length}/{closedToday.length} today
            </StatusBadge>
          )}
        </div>
        <div
          className={cn(
            "text-2xl tabular font-semibold mt-1",
            dailyPnl >= 0 ? "text-status-safe" : "text-status-blocked",
          )}
        >
          {dailyPnl >= 0 ? "+" : ""}${fmtMoney(dailyPnl)}{" "}
          <span className="text-sm text-muted-foreground">({dailyPnlPct.toFixed(2)}%)</span>
        </div>
      </div>

      {bySymbol.length > 0 && (
        <DrilldownSection title="Per-symbol attribution">
          <div className="rounded-md border border-border bg-background/40 overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto_auto] text-[10px] uppercase tracking-wider text-muted-foreground px-3 py-2 border-b border-border bg-card/40">
              <span>Symbol</span>
              <span className="px-2 text-right">Trades</span>
              <span className="px-2 text-right">P&amp;L</span>
              <span className="text-right">Win%</span>
            </div>
            {bySymbol.map((row) => (
              <div
                key={row.symbol}
                className="grid grid-cols-[1fr_auto_auto_auto] items-center px-3 py-2 text-xs border-b border-border/40 last:border-b-0"
              >
                <span className="text-foreground tabular">{row.symbol}</span>
                <span className="px-2 text-right tabular text-muted-foreground">{row.trades}</span>
                <span
                  className={cn(
                    "px-2 text-right tabular font-medium",
                    row.pnl > 0 ? "text-status-safe" : row.pnl < 0 ? "text-status-blocked" : "text-muted-foreground",
                  )}
                >
                  {row.pnl >= 0 ? "+" : ""}${fmtMoneyAdaptive(row.pnl)}
                </span>
                <span className="text-right tabular text-muted-foreground">
                  {row.winRate.toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </DrilldownSection>
      )}

      <DrilldownSection title="Realized vs unrealized">
        <div className="grid grid-cols-2 gap-2">
          <DrilldownStat
            label="Realized"
            value={`${realizedToday >= 0 ? "+" : ""}$${fmtMoney(realizedToday)}`}
            tone={realizedToday >= 0 ? "safe" : "blocked"}
          />
          <DrilldownStat
            label="Unrealized"
            value={`${unrealizedToday >= 0 ? "+" : ""}$${fmtMoney(unrealizedToday)}`}
            tone={unrealizedToday >= 0 ? "safe" : "blocked"}
          />
        </div>
      </DrilldownSection>

      <DrilldownSection
        title={`Today's closed trades · ${closedToday.length}`}
        action={
          closedToday.length > 0 && (
            <Link to="/trades" className="text-[11px] text-primary hover:underline" onClick={onClose}>
              See all →
            </Link>
          )
        }
      >
        {closedToday.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Nothing closed yet today. Quiet hands.</p>
        ) : (
          <div className="space-y-1">
            {closedToday.slice(0, 6).map((t) => (
              <TradeRow key={t.id} trade={t} showR />
            ))}
          </div>
        )}
      </DrilldownSection>
    </MetricDrilldownSheet>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// TRADES TODAY DRILLDOWN
// ════════════════════════════════════════════════════════════════════════════

function TradesTodayDrilldown({ open, onClose, open_, closedToday, pendingSignals }: Common) {
  const all = useMemo(
    () =>
      [...open_, ...closedToday].sort((a, b) => {
        const at = a.closedAt ?? a.openedAt;
        const bt = b.closedAt ?? b.openedAt;
        return new Date(bt).getTime() - new Date(at).getTime();
      }),
    [open_, closedToday],
  );

  const used = open_.length + closedToday.length;
  const cap = DOCTRINE.MAX_TRADES_PER_DAY;
  const remaining = Math.max(0, cap - used);
  const capacityTone = used >= cap ? "blocked" : used >= cap - 1 ? "caution" : "safe";

  const pending = pendingSignals ?? [];

  return (
    <MetricDrilldownSheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={
        <span className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          Trades today
        </span>
      }
      description={`${open_.length} open · ${closedToday.length} closed · cap ${cap}`}
    >
      {pending.length > 0 && (
        <Link
          to="/copilot"
          onClick={onClose}
          className="block rounded-md border border-primary/40 bg-primary/5 px-3 py-2.5 hover:bg-primary/10 transition-colors group"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-foreground">
              <span className="font-medium text-primary">{pending.length} pending signal{pending.length > 1 ? "s" : ""}</span>{" "}
              awaiting review
            </span>
            <span className="text-[11px] text-primary inline-flex items-center gap-0.5 group-hover:translate-x-0.5 transition-transform">
              Open Copilot <ArrowRight className="h-3 w-3" />
            </span>
          </div>
        </Link>
      )}

      <div
        className={cn(
          "rounded-md border px-3 py-2.5 flex items-center justify-between",
          capacityTone === "safe" && "border-status-safe/30 bg-status-safe/5",
          capacityTone === "caution" && "border-status-caution/30 bg-status-caution/5",
          capacityTone === "blocked" && "border-status-blocked/30 bg-status-blocked/5",
        )}
      >
        <div className="text-xs text-foreground">
          <span className="tabular font-medium">
            {used} of {cap} trade slots used
          </span>
          <span className="text-muted-foreground"> · {remaining} remaining today</span>
        </div>
        <StatusBadge tone={capacityTone} size="sm" dot>
          {capacityTone === "blocked" ? "cap hit" : capacityTone === "caution" ? "almost full" : "headroom"}
        </StatusBadge>
      </div>

      {all.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">No trades today. The cap is your friend.</p>
      ) : (
        <DrilldownSection title="Timeline">
          <div className="relative pl-4">
            {/* vertical rail */}
            <div className="absolute left-[5px] top-1.5 bottom-1.5 w-px bg-border" aria-hidden />
            <div className="space-y-2.5">
              {all.map((t) => {
                const isOpen = t.status === "open";
                const pnl = isOpen ? (t.unrealizedPnl ?? 0) : (t.pnl ?? 0);
                const ts = isOpen ? t.openedAt : (t.closedAt ?? t.openedAt);
                return (
                  <div key={t.id} className="relative flex items-center gap-3">
                    <span
                      className={cn(
                        "absolute -left-[15px] top-1/2 -translate-y-1/2 h-2.5 w-2.5 rounded-full border-2 border-background",
                        isOpen
                          ? "bg-primary animate-pulse"
                          : pnl > 0
                            ? "bg-status-safe"
                            : pnl < 0
                              ? "bg-status-blocked"
                              : "bg-muted-foreground",
                      )}
                      aria-hidden
                    />
                    <span className="text-[10px] tabular text-muted-foreground w-12 shrink-0">
                      {new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <span className="text-xs tabular text-foreground truncate">{t.symbol}</span>
                      <StatusBadge tone={t.side === "long" ? "safe" : "caution"} size="sm">
                        {t.side}
                      </StatusBadge>
                      {isOpen ? (
                        <StatusBadge tone="candidate" size="sm">
                          open
                        </StatusBadge>
                      ) : t.outcome ? (
                        <StatusBadge tone={t.outcome === "win" ? "safe" : t.outcome === "loss" ? "blocked" : "neutral"} size="sm">
                          {t.outcome}
                        </StatusBadge>
                      ) : null}
                    </div>
                    <span
                      className={cn(
                        "text-xs tabular font-medium shrink-0",
                        pnl > 0 ? "text-status-safe" : pnl < 0 ? "text-status-blocked" : "text-muted-foreground",
                      )}
                    >
                      {pnl >= 0 ? "+" : ""}${fmtMoneyAdaptive(pnl)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </DrilldownSection>
      )}

      <Button variant="outline" size="sm" asChild className="w-full">
        <Link to="/trades" onClick={onClose}>
          Open Trades page <ArrowRight className="h-3.5 w-3.5 ml-1" />
        </Link>
      </Button>
    </MetricDrilldownSheet>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// LOSS VS CAP DRILLDOWN
// ════════════════════════════════════════════════════════════════════════════

function LossVsCapDrilldown({ open, onClose, lossToday, lossVsCap, closedToday }: Common) {
  const losers = closedToday.filter((t) => (t.pnl ?? 0) < 0);
  const cap = 1.5; // %
  const pct = Math.min(100, (lossVsCap / cap) * 100);

  // Burn-rate projection: only meaningful once we've burned something.
  const projection = useMemo(() => {
    if (lossToday >= 0 || lossVsCap <= 0) return null;
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const hoursElapsed = Math.max(0.5, (Date.now() - start.getTime()) / 3600000);
    const burnRatePerHour = lossVsCap / hoursElapsed;
    if (burnRatePerHour <= 0) return null;
    const hoursToCap = (cap - lossVsCap) / burnRatePerHour;
    if (!isFinite(hoursToCap) || hoursToCap <= 0) return null;
    return { hoursToCap, burnRatePerHour };
  }, [lossToday, lossVsCap]);

  return (
    <MetricDrilldownSheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={
        <span className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-status-caution" />
          Daily loss vs cap
        </span>
      }
      description="The bot halts itself for the day at 100% of cap."
    >
      <div className="rounded-md border border-border bg-background/40 p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Burn-down</span>
          <span className="text-sm tabular text-foreground">
            {lossVsCap.toFixed(2)}% / {cap.toFixed(2)}%
          </span>
        </div>
        <div className="h-3 rounded-full bg-secondary overflow-hidden relative">
          <div
            className="h-full transition-all"
            style={{
              width: `${pct}%`,
              background:
                "linear-gradient(90deg, hsl(var(--status-safe)) 0%, hsl(var(--status-caution)) 60%, hsl(var(--status-blocked)) 100%)",
            }}
          />
        </div>
        <DrilldownStat
          label="Realized loss today"
          value={`${lossToday >= 0 ? "+" : ""}$${fmtMoneyAdaptive(lossToday)}`}
          tone={lossToday < 0 ? "blocked" : "default"}
        />
      </div>

      {lossToday >= 0 ? (
        <div className="rounded-md border border-status-safe/30 bg-status-safe/5 px-3 py-2.5 text-xs text-status-safe flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5" />
          No losses today. Cap fully intact.
        </div>
      ) : projection ? (
        <div className="rounded-md border border-status-caution/30 bg-status-caution/5 px-3 py-2.5 text-xs text-foreground flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 text-status-caution" />
          <span>
            At current burn rate:{" "}
            <span className="tabular font-medium">cap in ~{projection.hoursToCap.toFixed(1)}h</span>
          </span>
        </div>
      ) : null}

      <div className="rounded-md border border-border/60 bg-card/30 px-3 py-2.5 text-xs text-muted-foreground flex items-start gap-2">
        <Info className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
        <span>
          When loss reaches <span className="text-foreground tabular">1.50%</span>, the bot
          automatically halts for the remainder of the day. This resets at{" "}
          <span className="text-foreground tabular">00:05 UTC</span>.
        </span>
      </div>

      <DrilldownSection title={`Losing trades today · ${losers.length}`}>
        {losers.length === 0 ? (
          <p className="text-xs text-status-safe italic">Zero losers. Discipline paying off.</p>
        ) : (
          <div className="space-y-1">
            {losers.map((t) => (
              <TradeRow key={t.id} trade={t} showR />
            ))}
          </div>
        )}
      </DrilldownSection>

      <Button variant="outline" size="sm" asChild className="w-full">
        <Link to="/risk" onClick={onClose}>
          Tune loss cap in Risk Center <ArrowRight className="h-3.5 w-3.5 ml-1" />
        </Link>
      </Button>
    </MetricDrilldownSheet>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// FLOOR DISTANCE DRILLDOWN
// ════════════════════════════════════════════════════════════════════════════

function FloorDistanceDrilldown({ open, onClose, account, floorDistance, closed }: Common) {
  if (!account) {
    return (
      <MetricDrilldownSheet
        open={open}
        onOpenChange={(o) => !o && onClose()}
        title="Floor distance"
      >
        <p className="text-sm text-muted-foreground italic">No account state yet.</p>
      </MetricDrilldownSheet>
    );
  }
  const span = Math.max(account.equity, account.balanceFloor * 1.25);
  const equityPct = (account.equity / span) * 100;
  const floorPct = (account.balanceFloor / span) * 100;

  // Drawdown scenarios.
  const maxLoss = DOCTRINE.MAX_ORDER_USD; // worst-case single order ≈ one max loss
  const dailyCap = (account.startOfDayEquity * 0.015); // 1.5%
  const scenarios = [
    { label: `1 max loss (~$${maxLoss.toFixed(2)})`, equityAfter: account.equity - maxLoss },
    { label: `3 consecutive losses`, equityAfter: account.equity - maxLoss * 3 },
    { label: `Daily cap hit (-$${dailyCap.toFixed(2)})`, equityAfter: account.equity - dailyCap },
  ].map((s) => ({
    ...s,
    distancePct: ((s.equityAfter - account.balanceFloor) / Math.max(s.equityAfter, 1e-9)) * 100,
  }));

  // 7-day average daily PnL, projected against headroom.
  const projection = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const recent = closed.filter((t) => t.closedAt && new Date(t.closedAt).getTime() >= cutoff);
    if (recent.length === 0) return null;
    const totalPnl = recent.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const avgPerDay = totalPnl / 7;
    if (avgPerDay === 0) return { direction: "flat" as const, days: 0, avgPerDay };
    const headroom = account.equity - account.balanceFloor;
    if (avgPerDay > 0) return { direction: "growing" as const, days: 0, avgPerDay };
    const days = headroom / Math.abs(avgPerDay);
    return { direction: "shrinking" as const, days, avgPerDay };
  }, [closed, account.equity, account.balanceFloor]);

  return (
    <MetricDrilldownSheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={
        <span className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-status-safe" />
          Floor distance
        </span>
      }
      description="Hit the floor and the kill-switch trips automatically."
    >
      <div className="rounded-md border border-border bg-background/40 p-4 flex items-stretch gap-4">
        <div className="relative w-20 h-56 bg-secondary rounded-md overflow-hidden shrink-0">
          {/* Equity fill */}
          <div
            className="absolute bottom-0 left-0 right-0 bg-status-safe/40 transition-all"
            style={{ height: `${equityPct}%` }}
          />
          {/* Equity label at top of fill */}
          <div
            className="absolute left-0 right-0 -translate-y-full px-1 text-[9px] tabular text-status-safe text-center font-medium"
            style={{ bottom: `${equityPct}%` }}
          >
            ${fmtMoney(account.equity)}
          </div>
          {/* Floor line */}
          <div
            className="absolute left-0 right-0 border-t-2 border-status-blocked"
            style={{ bottom: `${floorPct}%` }}
          />
          <div
            className="absolute left-0 right-0 px-1 text-[9px] tabular text-status-blocked text-center"
            style={{ bottom: `calc(${floorPct}% - 12px)` }}
          >
            ${fmtMoney(account.balanceFloor)}
          </div>
        </div>
        <div className="flex-1 space-y-2">
          <DrilldownStat label="Equity" value={`$${fmtMoney(account.equity)}`} tone="safe" />
          <DrilldownStat label="Floor" value={`$${fmtMoney(account.balanceFloor)}`} tone="blocked" />
          <DrilldownStat
            label="Headroom"
            value={`$${fmtMoney(account.equity - account.balanceFloor)} (${floorDistance.toFixed(1)}%)`}
          />
        </div>
      </div>

      <DrilldownSection title="Drawdown scenarios">
        <div className="rounded-md border border-border bg-background/40 overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto] text-[10px] uppercase tracking-wider text-muted-foreground px-3 py-2 border-b border-border bg-card/40">
            <span>Scenario</span>
            <span className="px-2 text-right">Equity after</span>
            <span className="text-right">Floor dist</span>
          </div>
          {scenarios.map((s, i) => {
            const safe = s.distancePct >= 15;
            const danger = s.distancePct < 5;
            return (
              <div
                key={i}
                className="grid grid-cols-[1fr_auto_auto] items-center px-3 py-2 text-xs border-b border-border/40 last:border-b-0"
              >
                <span className="text-foreground">{s.label}</span>
                <span className="px-2 text-right tabular text-foreground">
                  ${fmtMoney(Math.max(s.equityAfter, 0))}
                </span>
                <span
                  className={cn(
                    "text-right tabular font-medium",
                    danger ? "text-status-blocked" : safe ? "text-status-safe" : "text-status-caution",
                  )}
                >
                  {s.distancePct.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      </DrilldownSection>

      {projection && (
        <div
          className={cn(
            "rounded-md border px-3 py-2.5 text-xs flex items-center gap-2",
            projection.direction === "growing"
              ? "border-status-safe/30 bg-status-safe/5 text-status-safe"
              : projection.direction === "flat"
                ? "border-border bg-card/30 text-muted-foreground"
                : "border-status-caution/30 bg-status-caution/5 text-foreground",
          )}
        >
          {projection.direction === "growing" ? (
            <TrendingUp className="h-3.5 w-3.5" />
          ) : (
            <TrendingDown className="h-3.5 w-3.5 text-status-caution" />
          )}
          <span>
            At last 7-day average:{" "}
            {projection.direction === "growing"
              ? "growing away from floor"
              : projection.direction === "flat"
                ? "treading water"
                : `floor in ~${projection.days.toFixed(0)} day${projection.days >= 2 ? "s" : ""}`}
          </span>
        </div>
      )}

      <Button variant="outline" size="sm" asChild className="w-full">
        <Link to="/risk" onClick={onClose}>
          Adjust floor in Risk Center <ArrowRight className="h-3.5 w-3.5 ml-1" />
        </Link>
      </Button>
    </MetricDrilldownSheet>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// LIVE MODE DRILLDOWN
// ════════════════════════════════════════════════════════════════════════════

interface ReadinessItem {
  pass: boolean;
  label: string;
  detail: string;
}

function LiveModeDrilldown({ open, onClose, system, closed }: Common) {
  const live = !!system?.liveTradingEnabled;

  // Inline scaling readiness. Computed from props we already have, plus
  // system_state. Same logic as ScalingReadinessPanel but without extra
  // network calls — broker check falls back to `system.brokerConnection`.
  const items = useMemo<ReadinessItem[]>(() => {
    const trades = closed;
    const tradeCount = trades.length;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const expR = tradeCount > 0 ? totalPnl / tradeCount : 0;
    const expectancyPass = tradeCount >= 50 && expR > 0;

    // Drawdown
    let peak = 0,
      equity = 0,
      maxDD = 0;
    const sorted = [...trades].sort(
      (a, b) => new Date(a.closedAt ?? 0).getTime() - new Date(b.closedAt ?? 0).getTime(),
    );
    for (const t of sorted) {
      equity += t.pnl ?? 0;
      if (equity > peak) peak = equity;
      if (peak > 0) {
        const dd = (peak - equity) / peak;
        if (dd > maxDD) maxDD = dd;
      }
    }
    const ddPct = maxDD * 100;
    const ddPass = tradeCount > 0 && ddPct < 25;

    // 30-day net
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const recent = trades.filter((t) => t.closedAt && new Date(t.closedAt).getTime() >= since);
    const netRecent = recent.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const netPass = netRecent > 0;

    const paramsWired = !!system?.paramsWiredLive;
    const brokerLive = system?.brokerConnection === "connected";

    return [
      {
        pass: expectancyPass,
        label: "≥50 paper trades with positive expectancy",
        detail: `current: ${tradeCount} trade${tradeCount === 1 ? "" : "s"}, ${expR >= 0 ? "+" : ""}${expR.toFixed(2)}R`,
      },
      {
        pass: ddPass,
        label: "Max drawdown under 25%",
        detail: tradeCount === 0 ? "current: no trades" : `current: ${ddPct.toFixed(1)}%`,
      },
      {
        pass: netPass,
        label: "Net profitable over last 30 days",
        detail: `current: ${netRecent >= 0 ? "+" : ""}$${fmtMoneyAdaptive(netRecent)}`,
      },
      {
        pass: paramsWired,
        label: "Strategy params wired into live engine",
        detail: paramsWired ? "wired" : "engine using defaults",
      },
      {
        pass: brokerLive,
        label: "Real broker connected",
        detail: brokerLive ? "broker reachable" : "no live broker linked",
      },
      {
        pass: tradeCount > 10,
        label: "At least one full learning cycle completed",
        detail: tradeCount > 10 ? "data accumulated" : "need more closed trades",
      },
    ];
  }, [closed, system]);

  const passing = items.filter((i) => i.pass).length;
  const allGreen = passing === items.length;

  return (
    <MetricDrilldownSheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          Live mode
        </span>
      }
      description={live ? "Real orders allowed (still subject to every guardrail)." : "Paper-only. No real orders."}
    >
      <div className="rounded-md border border-border bg-background/40 p-4 flex items-center gap-3">
        <StatusBadge tone={live ? "safe" : "blocked"} dot pulse={live}>
          {live ? "Armed" : "Gated"}
        </StatusBadge>
        <span className="text-sm text-foreground">
          {live ? "Operator-armed for live trading." : "Live trading is currently blocked."}
        </span>
      </div>

      <div className="rounded-md border border-border bg-background/40 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-foreground font-semibold">
            Live trading readiness
          </span>
          <StatusBadge tone={allGreen ? "safe" : "neutral"} size="sm">
            {passing}/{items.length}
          </StatusBadge>
        </div>
        <ul className="space-y-2">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              {item.pass ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-status-safe shrink-0 mt-0.5" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              )}
              <div className="flex-1 min-w-0">
                <div className={cn("leading-tight", item.pass ? "text-foreground" : "text-muted-foreground")}>
                  {item.label}
                </div>
                <div className="text-[10px] text-muted-foreground tabular mt-0.5">{item.detail}</div>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-muted-foreground border-t border-border pt-3">
          {allGreen
            ? "All checks green — arm live mode in Settings."
            : "All checks must be green before arming live mode."}
        </p>
      </div>

      <Button variant="outline" size="sm" asChild className="w-full">
        <Link to="/settings" onClick={onClose}>
          Open Settings → Bot controls <ArrowRight className="h-3.5 w-3.5 ml-1" />
        </Link>
      </Button>
    </MetricDrilldownSheet>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SHARED ROW COMPONENT
// ════════════════════════════════════════════════════════════════════════════

function TradeRow({ trade, showR = false }: { trade: Trade; showR?: boolean }) {
  const isOpen = trade.status === "open";
  const pnl = isOpen ? (trade.unrealizedPnl ?? 0) : (trade.pnl ?? 0);
  const r = showR && !isOpen ? rMultiple(trade) : null;
  return (
    <div className="flex items-center justify-between rounded-md border border-border/60 bg-background/30 px-3 py-1.5 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <StatusBadge tone={trade.side === "long" ? "safe" : "caution"} size="sm">
          {trade.side}
        </StatusBadge>
        <span className="text-foreground tabular truncate">
          {trade.symbol} @ ${trade.entryPrice.toFixed(2)}
        </span>
        {isOpen && (
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">open</span>
        )}
      </div>
      <span
        className={cn(
          "tabular font-medium shrink-0",
          pnl > 0 ? "text-status-safe" : pnl < 0 ? "text-status-blocked" : "text-muted-foreground",
        )}
      >
        {pnl >= 0 ? "+" : ""}${fmtMoneyAdaptive(pnl)}
        {r !== null && (
          <span className="text-muted-foreground/70 font-normal ml-1">
            / {r >= 0 ? "+" : ""}
            {r.toFixed(1)}R
          </span>
        )}
      </span>
    </div>
  );
}
