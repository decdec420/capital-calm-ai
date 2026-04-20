import { Bell, ShieldAlert, Wifi, WifiOff } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { StatusBadge } from "./StatusBadge";
import { systemState, alerts } from "@/mocks/data";
import { cn } from "@/lib/utils";
import type { SystemMode } from "@/mocks/types";

const modeTone: Record<SystemMode, "neutral" | "candidate" | "accent" | "blocked"> = {
  research: "neutral",
  paper: "candidate",
  learning: "accent",
  live: "blocked",
};

export function TopBar() {
  const s = systemState;
  return (
    <header className="h-14 border-b border-border bg-card/40 backdrop-blur supports-[backdrop-filter]:bg-card/40 flex items-center px-3 gap-3 shrink-0">
      <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
      <div className="h-5 w-px bg-border" />

      <StatusBadge tone={modeTone[s.mode]} dot pulse={s.mode === "live"}>
        {s.mode}
      </StatusBadge>

      <StatusBadge tone={s.bot === "running" ? "safe" : s.bot === "halted" ? "blocked" : "caution"} dot pulse={s.bot === "running"}>
        bot {s.bot}
      </StatusBadge>

      <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground">
        {s.brokerConnection === "connected" ? (
          <Wifi className="h-3.5 w-3.5 text-status-safe" />
        ) : (
          <WifiOff className="h-3.5 w-3.5 text-status-blocked" />
        )}
        <span className="tabular">{s.latencyMs}ms</span>
      </div>

      <div className="flex-1" />

      {s.killSwitchEngaged && (
        <StatusBadge tone="blocked" dot>
          <ShieldAlert className="h-3 w-3" /> kill-switch
        </StatusBadge>
      )}

      <button
        type="button"
        className="relative h-8 w-8 rounded-md hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Alerts"
      >
        <Bell className="h-4 w-4" />
        {alerts.length > 0 && (
          <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
        )}
      </button>

      <div className="flex items-center gap-2 pl-2 border-l border-border">
        <div className={cn("h-7 w-7 rounded-full bg-secondary border border-border flex items-center justify-center text-xs font-medium text-foreground")}>
          OP
        </div>
      </div>
    </header>
  );
}
