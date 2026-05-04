// ─────────────────────────────────────────────────────────────────────────────
// P1: GlobalStatusStrip.tsx
// New file → src/components/trader/GlobalStatusStrip.tsx
//
// A persistent 28px status bar below TopBar, visible on every authenticated
// page. Answers without a single click:
//   Equity · Daily PnL · Loss cap · Open positions · Block reason · Last signal
//
// Wire into AppLayout.tsx:
//   import { GlobalStatusStrip } from "@/components/trader/GlobalStatusStrip";
//   // Inside the flex-col div, between <TopBar /> and <BrokerReconnectBanner />:
//   <TopBar />
//   <GlobalStatusStrip />          ← add this line
//   <BrokerReconnectBanner />
// ─────────────────────────────────────────────────────────────────────────────

import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useAccountState } from "@/hooks/useAccountState";
import { useSystemState } from "@/hooks/useSystemState";
import { useTrades } from "@/hooks/useTrades";
import { useSignals } from "@/hooks/useSignals";
import { isStale } from "@/hooks/useRelativeTime";
import type { GateReason } from "@/lib/domain-types";

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number, digits = 2): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function Pip({ className }: { className?: string }) {
  return <span className={cn("h-3 w-px bg-border shrink-0", className)} />;
}

function Cell({
  label,
  children,
  to,
  className,
}: {
  label: string;
  children: React.ReactNode;
  to?: string;
  className?: string;
}) {
  const inner = (
    <span className={cn("flex items-center gap-1.5", className)}>
      <span className="text-muted-foreground/60">{label}</span>
      {children}
    </span>
  );
  if (to) {
    return (
      <Link
        to={to}
        className="hover:text-foreground transition-colors outline-none focus-visible:ring-1 focus-visible:ring-primary/40 rounded"
      >
        {inner}
      </Link>
    );
  }
  return inner;
}

// ─── primary block reason (halt/block severity only) ─────────────────────────

function blockReasonLabel(reasons: GateReason[]): string | null {
  const primary = reasons.find((r) => r.severity === "halt" || r.severity === "block");
  if (!primary) return null;
  // Short-form friendly labels keyed by gate code
  const SHORT: Record<string, string> = {
    KILL_SWITCH: "Kill switch engaged",
    BOT_PAUSED: "Bot paused",
    DAILY_LOSS_CAP: "Loss cap reached",
    TRADE_COUNT_CAP: "Trade cap reached",
    BALANCE_FLOOR: "Balance floor hit",
    CHOP_REGIME: "Chop regime",
    RANGE_REGIME: "Range regime",
    LOW_SETUP_SCORE: "Low setup score",
    STALE_DATA: "Data stale",
    ANTI_TILT_LOCK: "Anti-tilt lock",
    CONSECUTIVE_LOSS_HARD_STOP: "Hard stop: consecutive losses",
    TRADING_PAUSED_EVENT_MODE: "Event mode pause",
  };
  return SHORT[primary.code] ?? primary.message.slice(0, 40);
}

// ─── component ────────────────────────────────────────────────────────────────

export function GlobalStatusStrip() {
  const { data: account } = useAccountState();
  const { data: system } = useSystemState();
  const { open } = useTrades();
  const { pending: pendingSignals } = useSignals();

  // Compute values — graceful fallback to em-dashes while loading
  const equity = account ? `$${fmt(account.equity)}` : "—";

  const dailyPnl = account ? account.equity - account.startOfDayEquity : null;
  const dailyPnlStr = dailyPnl !== null
    ? `${dailyPnl >= 0 ? "+" : ""}$${fmt(Math.abs(dailyPnl))}`
    : "—";
  const pnlPositive = dailyPnl !== null && dailyPnl >= 0;
  const pnlNegative = dailyPnl !== null && dailyPnl < 0;

  const snapshot = system?.lastEngineSnapshot ?? null;
  const gateReasons = snapshot?.gateReasons ?? [];
  const blockReason = blockReasonLabel(gateReasons);
  const dataStale = isStale(snapshot ? new Date(snapshot.ranAt).getTime() : null);

  // Loss vs cap
  const lossToday = account
    ? Math.abs(Math.min(0, account.equity - account.startOfDayEquity))
    : 0;
  const lossCap = 0.015; // 1.50% — mirrors DOCTRINE constant
  const lossVsCap = account?.startOfDayEquity
    ? (lossToday / account.startOfDayEquity) * 100
    : 0;
  const lossNear = lossVsCap > 1.0;
  const lossStr = `${lossVsCap.toFixed(2)}% / 1.50%`;

  const openCount = open.length;

  // Last signal
  const lastSignal = pendingSignals[0] ?? null;
  const lastSignalStr = lastSignal
    ? `${lastSignal.side.toUpperCase()} ${lastSignal.symbol} · ${(lastSignal.confidence * 100).toFixed(0)}% conf`
    : null;

  // Live mode tint — very faint red background when live mode armed
  const isLive = system?.liveTradingEnabled ?? false;

  return (
    <div
      className={cn(
        "h-7 shrink-0 border-b border-border px-3",
        "flex items-center gap-3",
        "text-[10px] uppercase tracking-wider tabular font-mono",
        "text-muted-foreground",
        // Subtle live-mode tint — makes every page feel "hot" when real money is at risk
        isLive
          ? "bg-status-blocked/5 border-b-status-blocked/20"
          : "bg-card/40",
      )}
    >
      {/* Equity */}
      <Cell label="EQ" to="/performance" className="text-foreground/80">
        <span className="text-foreground font-semibold">{equity}</span>
      </Cell>

      <Pip />

      {/* Daily PnL */}
      <Cell
        label="PNL"
        to="/performance"
        className={cn(
          pnlPositive && "text-status-safe",
          pnlNegative && "text-status-blocked",
          !pnlPositive && !pnlNegative && "text-foreground/80",
        )}
      >
        <span className="font-semibold">{dailyPnlStr}</span>
      </Cell>

      <Pip />

      {/* Loss vs cap */}
      <Cell
        label="LOSS"
        to="/risk"
        className={cn(lossNear ? "text-status-caution" : "text-foreground/70")}
      >
        <span className={cn("font-semibold", lossNear && "text-status-caution")}>
          {lossStr}
        </span>
      </Cell>

      <Pip />

      {/* Open positions */}
      <Cell label="POS" to="/trades" className="text-foreground/70">
        <span className="font-semibold text-foreground/90">
          {openCount} open
        </span>
      </Cell>

      <Pip />

      {/* Data freshness */}
      <Cell
        label="DATA"
        className={cn(dataStale ? "text-status-caution" : "text-foreground/70")}
      >
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            dataStale ? "bg-status-caution animate-pulse-soft" : "bg-status-safe",
          )}
        />
        <span className={dataStale ? "text-status-caution font-semibold" : "text-foreground/70"}>
          {dataStale ? "stale" : "live"}
        </span>
      </Cell>

      {/* Block reason — only shown when actually blocked */}
      {blockReason && (
        <>
          <Pip />
          <Cell label="BLOCKED" to="/risk" className="text-status-blocked">
            <span className="font-semibold normal-case tracking-normal">
              {blockReason}
            </span>
          </Cell>
        </>
      )}

      {/* Spacer */}
      <span className="flex-1" />

      {/* Last pending signal — right-aligned */}
      {lastSignalStr && (
        <Cell label="SIGNAL" to="/copilot" className="text-primary">
          <span
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse-soft",
            )}
          />
          <span className="font-semibold normal-case tracking-normal">
            {lastSignalStr}
          </span>
        </Cell>
      )}

      {/* UTC clock — rightmost */}
      <Pip />
      <span className="text-muted-foreground/50">
        UTC {new Date().toUTCString().slice(17, 22)}
      </span>
    </div>
  );
}
