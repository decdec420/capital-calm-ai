import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, ArrowRight, DollarSign, ShieldAlert, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { MetricDrilldownSheet, DrilldownSection, DrilldownStat } from "./MetricDrilldownSheet";
import { Sparkline } from "./Sparkline";
import { StatusBadge } from "./StatusBadge";
import { Button } from "@/components/ui/button";
import type { AccountState, Trade, SystemState } from "@/lib/domain-types";
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

type Common = Omit<MetricDrilldownsProps, "open" | "onOpenChange"> & { open: boolean; onClose: () => void };

function fmtMoney(n: number, opts: Intl.NumberFormatOptions = {}) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2, ...opts });
}

function EquityDrilldown({ open, onClose, account, open_, closed }: Common) {
  // Build a synthetic equity history from start-of-day + cumulative realized PnL
  // over the last N closed trades. Honest approximation since we don't store
  // hourly snapshots yet.
  const series = useMemo(() => {
    if (!account) return [] as number[];
    const sorted = [...closed]
      .filter((t) => t.closedAt)
      .sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime())
      .slice(-30);
    const startEquity = account.equity - sorted.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const out: number[] = [startEquity];
    let running = startEquity;
    for (const t of sorted) {
      running += t.pnl ?? 0;
      out.push(running);
    }
    return out;
  }, [account, closed]);

  const openMTM = open_.reduce(
    (s, t) => s + (t.unrealizedPnl ?? 0),
    0,
  );
  const openMarketValue = open_.reduce((s, t) => s + (t.currentPrice ?? t.entryPrice) * t.size, 0);

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
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Equity now</span>
              <span className="text-2xl tabular font-semibold text-foreground">
                ${fmtMoney(account.equity)}
              </span>
            </div>
            <Sparkline values={series} height={60} />
            <p className="text-[11px] text-muted-foreground italic">
              Trail of recent closed trades. Real hourly snapshots coming later.
            </p>
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

function DailyPnlDrilldown({
  open,
  onClose,
  account,
  closedToday,
  realizedToday,
  unrealizedToday,
  dailyPnl,
  dailyPnlPct,
}: Common) {
  const winners = closedToday.filter((t) => (t.pnl ?? 0) > 0);
  const losers = closedToday.filter((t) => (t.pnl ?? 0) < 0);
  const biggestWin = winners.reduce<Trade | null>(
    (best, t) => (best && (best.pnl ?? 0) > (t.pnl ?? 0) ? best : t),
    null,
  );
  const biggestLoss = losers.reduce<Trade | null>(
    (worst, t) => (worst && (worst.pnl ?? 0) < (t.pnl ?? 0) ? worst : t),
    null,
  );

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
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Total today</div>
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

      {(biggestWin || biggestLoss) && (
        <DrilldownSection title="Highlights">
          <div className="grid grid-cols-1 gap-2">
            {biggestWin && (
              <HighlightRow
                label="Biggest winner"
                trade={biggestWin}
                tone="safe"
              />
            )}
            {biggestLoss && (
              <HighlightRow
                label="Biggest loser"
                trade={biggestLoss}
                tone="blocked"
              />
            )}
          </div>
        </DrilldownSection>
      )}

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
              <TradeRow key={t.id} trade={t} />
            ))}
          </div>
        )}
      </DrilldownSection>
    </MetricDrilldownSheet>
  );
}

function TradesTodayDrilldown({ open, onClose, open_, closedToday }: Common) {
  const all = [...open_, ...closedToday].sort((a, b) => {
    const at = a.closedAt ?? a.openedAt;
    const bt = b.closedAt ?? b.openedAt;
    return new Date(bt).getTime() - new Date(at).getTime();
  });
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
      description={`${open_.length} open · ${closedToday.length} closed · cap 6`}
    >
      {all.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">No trades today. The cap is your friend.</p>
      ) : (
        <div className="space-y-1.5">
          {all.map((t) => (
            <TradeRow key={t.id} trade={t} />
          ))}
        </div>
      )}
      <Button variant="outline" size="sm" asChild className="w-full">
        <Link to="/trades" onClick={onClose}>
          Open Trades page <ArrowRight className="h-3.5 w-3.5 ml-1" />
        </Link>
      </Button>
    </MetricDrilldownSheet>
  );
}

function LossVsCapDrilldown({ open, onClose, account, lossToday, lossVsCap, closedToday }: Common) {
  const losers = closedToday.filter((t) => (t.pnl ?? 0) < 0);
  const cap = 1.5; // %
  const pct = Math.min(100, (lossVsCap / cap) * 100);

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
        <div className="h-2 rounded-full bg-secondary overflow-hidden">
          <div
            className={cn(
              "h-full transition-all",
              pct > 80 ? "bg-status-blocked" : pct > 50 ? "bg-status-caution" : "bg-status-safe",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <DrilldownStat
          label="Realized loss today"
          value={`${lossToday >= 0 ? "+" : ""}$${fmtMoney(lossToday)}`}
          tone={lossToday < 0 ? "blocked" : "default"}
        />
      </div>

      <DrilldownSection title={`Losing trades today · ${losers.length}`}>
        {losers.length === 0 ? (
          <p className="text-xs text-status-safe italic">Zero losers. Discipline paying off.</p>
        ) : (
          <div className="space-y-1">
            {losers.map((t) => (
              <TradeRow key={t.id} trade={t} />
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

function FloorDistanceDrilldown({ open, onClose, account, floorDistance }: Common) {
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
  // Visualize equity above floor as a vertical bar.
  const span = Math.max(account.equity, account.balanceFloor * 1.25);
  const equityPct = (account.equity / span) * 100;
  const floorPct = (account.balanceFloor / span) * 100;

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
        <div className="relative w-16 h-40 bg-secondary rounded-md overflow-hidden">
          <div
            className="absolute bottom-0 left-0 right-0 bg-status-safe/40"
            style={{ height: `${equityPct}%` }}
          />
          <div
            className="absolute left-0 right-0 border-t-2 border-status-blocked"
            style={{ bottom: `${floorPct}%` }}
          />
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
      <Button variant="outline" size="sm" asChild className="w-full">
        <Link to="/risk" onClick={onClose}>
          Adjust floor in Risk Center <ArrowRight className="h-3.5 w-3.5 ml-1" />
        </Link>
      </Button>
    </MetricDrilldownSheet>
  );
}

function LiveModeDrilldown({ open, onClose, system }: Common) {
  const live = !!system?.liveTradingEnabled;
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
      <p className="text-xs text-muted-foreground">
        {live
          ? "Toggling off returns to paper instantly. No open positions are auto-closed."
          : "Arming requires every guardrail to pass and an explicit operator confirm."}
      </p>
      <Button variant="outline" size="sm" asChild className="w-full">
        <Link to="/settings" onClick={onClose}>
          Open Settings → Mode controls <ArrowRight className="h-3.5 w-3.5 ml-1" />
        </Link>
      </Button>
    </MetricDrilldownSheet>
  );
}

function HighlightRow({ label, trade, tone }: { label: string; trade: Trade; tone: "safe" | "blocked" }) {
  const color = tone === "safe" ? "text-status-safe" : "text-status-blocked";
  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-background/40 px-3 py-2">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-sm text-foreground tabular">
          {trade.side.toUpperCase()} {trade.symbol} @ ${trade.entryPrice.toFixed(2)}
        </div>
      </div>
      <div className={cn("text-sm tabular font-medium", color)}>
        {(trade.pnl ?? 0) >= 0 ? "+" : ""}${fmtMoney(trade.pnl ?? 0)}
      </div>
    </div>
  );
}

function TradeRow({ trade }: { trade: Trade }) {
  const isOpen = trade.status === "open";
  const pnl = isOpen ? (trade.unrealizedPnl ?? 0) : (trade.pnl ?? 0);
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
        {pnl >= 0 ? "+" : ""}${fmtMoney(pnl)}
      </span>
    </div>
  );
}
