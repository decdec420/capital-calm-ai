import { ShieldAlert, Wifi, WifiOff } from "lucide-react";
import { Link } from "react-router-dom";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { StatusBadge } from "./StatusBadge";
import { Explain } from "./Explain";
import { ExplainModeToggle } from "./ExplainModeToggle";
import type { SystemMode } from "@/lib/domain-types";
import { useSystemState } from "@/hooks/useSystemState";

const modeTone: Record<SystemMode, "neutral" | "candidate" | "accent" | "blocked"> = {
  research: "neutral",
  paper: "candidate",
  learning: "accent",
  live: "blocked",
};

const modeHints: Record<SystemMode, string> = {
  research: "No orders. Just looking, taking notes, kicking tires.",
  paper: "Simulated trades against live prices. No real money at risk.",
  learning: "Bot proposes trades but waits for you to approve each one.",
  live: "Real money, real orders. All guardrails active. Be sure.",
};

export function TopBar() {
  const { data: s } = useSystemState();

  return (
    <header className="h-14 border-b border-border bg-card/40 backdrop-blur supports-[backdrop-filter]:bg-card/40 flex items-center px-3 gap-2 shrink-0">
      <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
      <div className="h-5 w-px bg-border" />

      {s && (
        <>
          {/* System mode → settings */}
          <Explain inline title="System mode" hint={modeHints[s.mode]}>
            <Link
              to="/settings"
              className="rounded-full hover:opacity-80 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              aria-label={`System mode: ${s.mode}. Open settings.`}
            >
              <StatusBadge tone={modeTone[s.mode]} dot pulse={s.mode === "live"}>
                {s.mode}
              </StatusBadge>
            </Link>
          </Explain>

          {/* Bot status → risk center (where kill-switch lives) */}
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

          {/* Broker connection → settings */}
          <Link
            to="/settings"
            className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            aria-label={`Broker ${s.brokerConnection}. Open settings.`}
          >
            {s.brokerConnection === "connected" ? (
              <Wifi className="h-3.5 w-3.5 text-status-safe" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 text-status-blocked" />
            )}
            <span className="tabular capitalize">{s.brokerConnection}</span>
          </Link>
        </>
      )}

      <div className="flex-1" />

      {s?.killSwitchEngaged && (
        <Link
          to="/risk"
          className="rounded-full hover:opacity-80 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          aria-label="Kill-switch engaged. Open risk center."
        >
          <StatusBadge tone="blocked" dot>
            <ShieldAlert className="h-3 w-3" /> kill-switch
          </StatusBadge>
        </Link>
      )}

      <ExplainModeToggle />
    </header>
  );
}
