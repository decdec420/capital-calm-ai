import { ShieldAlert, Wifi, Activity, DollarSign } from "lucide-react";
import { Link } from "react-router-dom";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { StatusBadge } from "./StatusBadge";
import { ExplainModeToggle } from "./ExplainModeToggle";
import { LiveModeIndicator } from "./LiveModeIndicator";
import { useSystemState } from "@/hooks/useSystemState";
import { useAccountState } from "@/hooks/useAccountState";
import { cn } from "@/lib/utils";

// ─── tiny chip ───────────────────────────────────────────────────────────────

function CommandChip({
  label,
  value,
  tone,
  to,
}: {
  label: string;
  value: string;
  tone?: "safe" | "caution" | "blocked" | "muted";
  to?: string;
}) {
  const inner = (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
        "text-[10px] font-mono font-medium uppercase tracking-wider",
        "transition-opacity hover:opacity-80",
        tone === "safe"    && "border-status-safe/30 bg-status-safe/8 text-status-safe",
        tone === "caution" && "border-status-caution/30 bg-status-caution/8 text-status-caution",
        tone === "blocked" && "border-status-blocked/30 bg-status-blocked/8 text-status-blocked",
        !tone              && "border-border bg-secondary/60 text-muted-foreground",
      )}
    >
      <span className="text-muted-foreground/50">{label}</span>
      <span className={cn(
        tone === "safe"    && "text-status-safe",
        tone === "caution" && "text-status-caution",
        tone === "blocked" && "text-status-blocked",
        !tone              && "text-foreground/80",
      )}>
        {value}
      </span>
    </span>
  );
  if (to) {
    return (
      <Link to={to} aria-label={`${label} ${value}`} className="outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-full">
        {inner}
      </Link>
    );
  }
  return inner;
}

// ─── component ────────────────────────────────────────────────────────────────

export function TopBar() {
  const { data: s } = useSystemState();
  const { data: account } = useAccountState();

  // BTC price from last engine snapshot
  const btcSnap = s?.lastEngineSnapshot?.perSymbol.find((p) => p.symbol === "BTC-USD");
  const btcPrice = btcSnap?.lastPrice;

  return (
    <header className="h-11 border-b border-border bg-card/40 backdrop-blur supports-[backdrop-filter]:bg-card/40 flex items-center px-3 gap-2 shrink-0">
      {/* Sidebar toggle */}
      <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
      <div className="h-4 w-px bg-border" />

      {s && (
        <>
          {/* Paper / Live badge */}
          <LiveModeIndicator liveTradingEnabled={s.liveTradingEnabled} />

          {/* Bot status */}
          <Link
            to="/risk"
            className="rounded-full hover:opacity-80 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            aria-label={`Bot ${s.bot}. Open risk center.`}
          >
            <StatusBadge
              tone={s.bot === "running" ? "safe" : s.bot === "halted" ? "blocked" : "caution"}
              dot
              pulse={s.bot === "running"}
            >
              bot {s.bot}
            </StatusBadge>
          </Link>

          <div className="h-4 w-px bg-border hidden sm:block" />

          {/* BTC price chip */}
          {btcPrice && (
            <CommandChip
              label="BTC"
              value={`$${btcPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
              to="/market"
            />
          )}

          {/* Data feed health */}
          <CommandChip
            label="FEED"
            value={s.dataFeed === "connected" ? "live" : s.dataFeed}
            tone={s.dataFeed === "connected" ? "safe" : "blocked"}
          />

          {/* Broker health */}
          <CommandChip
            label="BROKER"
            value={
              s.mode === "paper"
                ? "paper"
                : s.brokerConnection === "connected"
                  ? "ok"
                  : s.brokerConnection
            }
            tone={
              s.mode === "paper"
                ? undefined
                : s.brokerConnection === "connected"
                  ? "safe"
                  : "blocked"
            }
            to="/settings"
          />
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Kill-switch engaged indicator */}
      {s?.killSwitchEngaged && (
        <Link
          to="/risk"
          className="rounded-full hover:opacity-80 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          aria-label="Kill-switch engaged. Open risk center."
        >
          <StatusBadge tone="blocked" dot pulse>
            <ShieldAlert className="h-3 w-3" /> kill-switch
          </StatusBadge>
        </Link>
      )}

      <ExplainModeToggle />
    </header>
  );
}

