// ============================================================
// DoctrineGuardrailGrid
// ------------------------------------------------------------
// The *real* engine-enforced guardrails, derived live from
// doctrine constants + account state + today's trades. This is
// the source of truth — the user-defined "extra" guardrails
// (in the legacy GuardrailRow grid below this one) are
// supplementary annotations, not what the engine actually checks.
// ============================================================

import { useMemo } from "react";
import {
  DollarSign,
  Gauge,
  Hand,
  Layers,
  ShieldAlert,
  TrendingDown,
  WifiOff,
} from "lucide-react";
import { useAccountState } from "@/hooks/useAccountState";
import { useTrades } from "@/hooks/useTrades";
import { useSystemState } from "@/hooks/useSystemState";
import { DOCTRINE, getProfile } from "@/lib/doctrine-constants";
import { formatUsd } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";

type Tone = "safe" | "caution" | "blocked";

interface DerivedRow {
  key: string;
  label: string;
  description: string;
  icon: typeof ShieldAlert;
  current: string;
  limit: string;
  utilization: number; // 0-1
  tone: Tone;
}

const toneToClasses: Record<Tone, { bar: string; text: string }> = {
  safe:    { bar: "bg-status-safe",    text: "text-status-safe" },
  caution: { bar: "bg-status-caution", text: "text-status-caution" },
  blocked: { bar: "bg-status-blocked", text: "text-status-blocked" },
};

function toneFor(util: number, blockedAt = 1.0): Tone {
  if (util >= blockedAt) return "blocked";
  if (util >= 0.7) return "caution";
  return "safe";
}

export function DoctrineGuardrailGrid() {
  const { data: account } = useAccountState();
  const { open, closed } = useTrades();
  const { data: system } = useSystemState();

  const rows = useMemo<DerivedRow[]>(() => {
    const equity = account?.equity ?? 0;
    const profile = getProfile(system?.activeProfile);
    const PROFILE_MAX_ORDER = profile.maxOrderUsdHardCap;
    const PROFILE_MAX_TRADES = profile.maxDailyTradesHardCap;
    const PROFILE_MAX_DAILY_LOSS = profile.maxDailyLossUsdHardCap;
    const PROFILE_MAX_DAILY_LOSS_PCT = profile.maxDailyLossPct;
    const PROFILE_MAX_CORR = profile.maxCorrelatedPositions;

    // 1. Per-order cap.
    const orderUtil = equity > 0 ? Math.min(1, PROFILE_MAX_ORDER / equity) : 0;

    // 2. Daily realized loss (today, UTC).
    const utcMidnight = new Date();
    utcMidnight.setUTCHours(0, 0, 0, 0);
    const realizedLossToday = closed
      .filter((t) => t.closedAt && new Date(t.closedAt) >= utcMidnight)
      .reduce((acc, t) => acc + Math.min(0, t.pnl ?? 0), 0);
    const lossUsdAbs = Math.abs(realizedLossToday);
    const lossLimitUsd = Math.min(PROFILE_MAX_DAILY_LOSS, equity * PROFILE_MAX_DAILY_LOSS_PCT);
    const lossUtil = lossLimitUsd > 0 ? Math.min(1, lossUsdAbs / lossLimitUsd) : 0;

    // 3. Daily trade count.
    const tradesToday =
      closed.filter((t) => t.openedAt && new Date(t.openedAt) >= utcMidnight).length +
      open.filter((t) => t.openedAt && new Date(t.openedAt) >= utcMidnight).length;
    const tradeUtil = Math.min(1, tradesToday / PROFILE_MAX_TRADES);

    // 4. Kill-switch floor (global, never per-profile).
    const headroomToFloor = Math.max(0, equity - DOCTRINE.KILL_SWITCH_FLOOR_USD);
    const floorUtil = equity > 0
      ? Math.min(1, Math.max(0, 1 - headroomToFloor / Math.max(equity, DOCTRINE.KILL_SWITCH_FLOOR_USD)))
      : 1;

    // 5. Correlated positions cap.
    const corrUtil = Math.min(1, open.length / PROFILE_MAX_CORR);

    // 6. Stale-data check from system state (informational — engine handles
    // the real check during a tick, this is the dashboard mirror).
    const staleHealthy = system?.dataFeed === "connected";

    return [
      {
        key: "max-order",
        label: "Max order size",
        description: `Single order capped at ${formatUsd(PROFILE_MAX_ORDER)} regardless of confidence (${profile.label} profile).`,
        icon: Gauge,
        current: formatUsd(PROFILE_MAX_ORDER),
        limit: formatUsd(PROFILE_MAX_ORDER),
        utilization: orderUtil,
        tone: "safe",
      },
      {
        key: "daily-loss",
        label: "Daily loss cap",
        description: `Halts new entries at ${formatUsd(lossLimitUsd)} losses today (min of ${formatUsd(PROFILE_MAX_DAILY_LOSS)} or ${(PROFILE_MAX_DAILY_LOSS_PCT * 100).toFixed(0)}% of equity).`,
        icon: TrendingDown,
        current: formatUsd(lossUsdAbs),
        limit: formatUsd(lossLimitUsd),
        utilization: lossUtil,
        tone: toneFor(lossUtil),
      },
      {
        key: "trade-count",
        label: "Daily trade cap",
        description: `Hard ceiling of ${PROFILE_MAX_TRADES} trades per UTC day (${profile.label} profile). Overtrading is failure.`,
        icon: Hand,
        current: `${tradesToday}`,
        limit: `${PROFILE_MAX_TRADES}`,
        utilization: tradeUtil,
        tone: toneFor(tradeUtil),
      },
      {
        key: "balance-floor",
        label: "Kill-switch floor",
        description: `Trading halts permanently if equity drops below ${formatUsd(DOCTRINE.KILL_SWITCH_FLOOR_USD)}.`,
        icon: DollarSign,
        current: formatUsd(equity),
        limit: formatUsd(DOCTRINE.KILL_SWITCH_FLOOR_USD),
        utilization: floorUtil,
        tone: toneFor(floorUtil),
      },
      {
        key: "correlation",
        label: "Correlated positions",
        description: `Up to ${PROFILE_MAX_CORR} open crypto positions at a time — BTC/ETH/SOL move together.`,
        icon: Layers,
        current: `${open.length}`,
        limit: `${PROFILE_MAX_CORR}`,
        utilization: corrUtil,
        tone: corrUtil >= 1 ? "blocked" : "safe",
      },
      {
        key: "stale-data",
        label: "Live data feed",
        description: `Signals reject if last tick is older than ${DOCTRINE.STALE_DATA_SECONDS}s.`,
        icon: WifiOff,
        current: staleHealthy ? "connected" : "stale",
        limit: `${DOCTRINE.STALE_DATA_SECONDS}s`,
        utilization: staleHealthy ? 0.05 : 1,
        tone: staleHealthy ? "safe" : "blocked",
      },
    ];
  }, [account?.equity, open, closed, system?.dataFeed]);

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Doctrine guardrails</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            What the engine actually enforces. Live — derived from your account, today's trades, and the doctrine constants.
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          source of truth
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {rows.map((r) => <DoctrineRow key={r.key} row={r} />)}
      </div>
    </div>
  );
}

function DoctrineRow({ row }: { row: DerivedRow }) {
  const Icon = row.icon;
  const pct = Math.min(100, Math.max(0, row.utilization * 100));
  const tc = toneToClasses[row.tone];
  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-start gap-2.5">
          <div className={cn(
            "h-7 w-7 rounded-md border flex items-center justify-center shrink-0 mt-0.5",
            row.tone === "safe" && "bg-secondary border-border text-muted-foreground",
            row.tone === "caution" && "bg-status-caution/15 border-status-caution/30 text-status-caution",
            row.tone === "blocked" && "bg-status-blocked/15 border-status-blocked/30 text-status-blocked",
          )}>
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-foreground">{row.label}</p>
              <StatusBadge tone={row.tone} size="sm" dot>
                {row.tone}
              </StatusBadge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{row.description}</p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="flex items-baseline justify-end gap-3">
            <div className="text-sm tabular text-foreground">{row.current}</div>
            <div className={cn("text-sm tabular font-semibold", tc.text)}>
              {Math.round(row.utilization * 100)}%
            </div>
          </div>
          <div className="text-[11px] text-muted-foreground tabular">limit {row.limit}</div>
        </div>
      </div>
      <div style={{ height: "4px", background: "hsl(var(--border))", borderRadius: "2px", width: "100%" }}>
        <div
          className={tc.bar}
          style={{ width: `${pct}%`, height: "4px", borderRadius: "2px", transition: "width 200ms ease-out" }}
        />
      </div>
      {row.utilization >= 1 && (
        <p className="text-[10px] font-semibold text-status-blocked">⛔ Limit reached — engine will block new entries.</p>
      )}
      {row.utilization < 1 && row.utilization > 0.85 && (
        <p className="text-[10px] font-semibold text-status-caution animate-pulse-soft">⚠ Approaching limit</p>
      )}
    </div>
  );
}
