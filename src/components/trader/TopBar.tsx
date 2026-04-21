import { LogOut, ShieldAlert, Wifi, WifiOff } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "./StatusBadge";
import { Explain } from "./Explain";
import { ExplainModeToggle } from "./ExplainModeToggle";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
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

const initialsFor = (name?: string | null, email?: string | null) => {
  const source = (name || email || "OP").trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const initials = (parts[0]?.[0] ?? "O") + (parts[1]?.[0] ?? "");
  return initials.toUpperCase().slice(0, 2);
};

export function TopBar() {
  const { user, profile, signOut } = useAuth();
  const { data: s } = useSystemState();
  const handleSignOut = async () => {
    await signOut();
    toast.success("Signed out. Stay disciplined.");
  };

  const displayName = profile?.display_name || user?.email?.split("@")[0] || "Operator";
  const initials = initialsFor(profile?.display_name, user?.email);

  return (
    <header className="h-14 border-b border-border bg-card/40 backdrop-blur supports-[backdrop-filter]:bg-card/40 flex items-center px-3 gap-3 shrink-0">
      <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
      <div className="h-5 w-px bg-border" />

      {s && (
        <>
          <Explain
            inline
            title="System mode"
            hint={modeHints[s.mode]}
          >
            <StatusBadge tone={modeTone[s.mode]} dot pulse={s.mode === "live"}>
              {s.mode}
            </StatusBadge>
          </Explain>

          <StatusBadge tone={s.bot === "running" ? "safe" : s.bot === "halted" ? "blocked" : "caution"} dot pulse={s.bot === "running"}>
            bot {s.bot}
          </StatusBadge>

          <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground">
            {s.brokerConnection === "connected" ? (
              <Wifi className="h-3.5 w-3.5 text-status-safe" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 text-status-blocked" />
            )}
            <span className="tabular capitalize">{s.brokerConnection}</span>
          </div>
        </>
      )}

      <div className="flex-1" />

      {s?.killSwitchEngaged && (
        <StatusBadge tone="blocked" dot>
          <ShieldAlert className="h-3 w-3" /> kill-switch
        </StatusBadge>
      )}

      <ExplainModeToggle />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 pl-2 border-l border-border hover:opacity-80 transition-opacity outline-none"
            aria-label="Operator menu"
          >
            <div
              className={cn(
                "h-7 w-7 rounded-full bg-secondary border border-border flex items-center justify-center text-[11px] font-medium text-foreground",
              )}
            >
              {initials}
            </div>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-foreground">{displayName}</span>
              <span className="text-[11px] text-muted-foreground truncate">{user?.email}</span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleSignOut} className="text-destructive focus:text-destructive">
            <LogOut className="h-4 w-4 mr-2" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
