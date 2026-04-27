// ============================================================
// PerTradeStopPanel
// ------------------------------------------------------------
// Surfaces the *actual* auto-sell behavior for the open position:
// the stop price, distance from current, and $ at risk if it hits.
// This is the missing answer to "when does the bot bail out?".
// ============================================================

import { ShieldOff, Target, TrendingDown } from "lucide-react";
import { useTrades } from "@/hooks/useTrades";
import { useCandles } from "@/hooks/useCandles";
import { formatBaseQty, formatUsd } from "@/lib/utils";
import { DOCTRINE } from "@/lib/doctrine-constants";

export function PerTradeStopPanel() {
  const { open } = useTrades();
  const { candles } = useCandles();
  const lastPrice = candles[candles.length - 1]?.c ?? null;
  const t = open[0];

  // No open position — show what the *next* trade will do, not nothing.
  if (!t) {
    return (
      <div className="panel p-4 space-y-3">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-md bg-secondary border border-border text-muted-foreground flex items-center justify-center">
            <ShieldOff className="h-3.5 w-3.5" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Per-trade auto-sell</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Every entry ships with a stop-loss. No open trade right now.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
          <Stat label="Risk per trade" value={`${(DOCTRINE.RISK_PER_TRADE_PCT * 100).toFixed(1)}% of equity`} />
          <Stat label="On a fresh entry" value={`stop sized to risk this much`} muted />
        </div>
      </div>
    );
  }

  const stop = t.stopLoss;
  const entry = t.entryPrice;
  const last = lastPrice ?? t.currentPrice ?? entry;
  const sideMult = t.side === "long" ? 1 : -1;

  // Distance from CURRENT to stop (the part that matters in real time).
  const distToStopPct = stop !== null
    ? Math.abs((last - stop) / last) * 100
    : null;

  // $ at risk if the stop fires from here.
  const dollarAtRisk = stop !== null
    ? Math.max(0, (last - stop) * t.size * sideMult)
    : null;

  // Adverse-move tolerance from entry — fixed property of the trade.
  const stopDistFromEntryPct = stop !== null
    ? Math.abs((entry - stop) / entry) * 100
    : null;

  // How "close" to the stop we are: 0% = at entry, 100% = at stop.
  const proximityPct = stop !== null && stopDistFromEntryPct !== null && stopDistFromEntryPct > 0
    ? Math.min(100, Math.max(0, ((entry - last) * sideMult / (entry - stop) / sideMult) * 100))
    : 0;

  const tone = proximityPct > 75 ? "blocked" : proximityPct > 40 ? "caution" : "safe";
  const toneClass = tone === "blocked" ? "text-status-blocked"
    : tone === "caution" ? "text-status-caution"
    : "text-status-safe";
  const barClass = tone === "blocked" ? "bg-status-blocked"
    : tone === "caution" ? "bg-status-caution"
    : "bg-status-safe";

  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className={`h-7 w-7 rounded-md flex items-center justify-center shrink-0 mt-0.5 ${
            tone === "blocked" ? "bg-status-blocked/15 text-status-blocked"
            : tone === "caution" ? "bg-status-caution/15 text-status-caution"
            : "bg-status-safe/15 text-status-safe"
          }`}>
            <Target className="h-3.5 w-3.5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-foreground">Per-trade auto-sell</p>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground bg-secondary border border-border rounded px-1.5 py-0.5">
                {t.symbol} · {t.side}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              If price hits the stop, the position closes automatically.
            </p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-sm tabular font-semibold ${toneClass}`}>
            {distToStopPct !== null ? `${distToStopPct.toFixed(2)}% to stop` : "—"}
          </div>
          <div className="text-[11px] text-muted-foreground tabular">
            stop @ {stop !== null ? `$${stop.toFixed(2)}` : "no stop set"}
          </div>
        </div>
      </div>

      {/* Proximity bar: 0 (at entry) → 100 (at stop) */}
      <div
        style={{ height: "4px", background: "hsl(var(--border))", borderRadius: "2px", width: "100%" }}
        title={`${proximityPct.toFixed(0)}% of the way from entry to stop`}
      >
        <div
          className={barClass}
          style={{
            width: `${proximityPct}%`,
            height: "4px",
            borderRadius: "2px",
            transition: "width 200ms ease-out",
          }}
        />
      </div>

      <div className="grid grid-cols-3 gap-3 pt-2 border-t border-border">
        <Stat
          label="Stop distance"
          value={stopDistFromEntryPct !== null ? `${stopDistFromEntryPct.toFixed(2)}%` : "—"}
          hint="from entry"
        />
        <Stat
          label="At risk now"
          value={dollarAtRisk !== null ? formatUsd(dollarAtRisk) : "—"}
          hint="if stop fires from here"
        />
        <Stat
          label="Position"
          value={`${formatBaseQty(t.size)}`}
          hint={formatUsd(t.size * last)}
        />
      </div>

      {tone === "blocked" && (
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-status-blocked pt-1">
          <TrendingDown className="h-3 w-3" />
          Within reach of stop — bot will close out if price keeps moving against you.
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint, muted }: { label: string; value: string; hint?: string; muted?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-sm tabular font-medium ${muted ? "text-muted-foreground" : "text-foreground"}`}>
        {value}
      </div>
      {hint && <div className="text-[10px] text-muted-foreground/70 tabular">{hint}</div>}
    </div>
  );
}
