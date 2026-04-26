import { ShieldAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { StatusBadge } from "./StatusBadge";
import { ExplainModeToggle } from "./ExplainModeToggle";
import { LiveModeIndicator } from "./LiveModeIndicator";
import { useSystemState } from "@/hooks/useSystemState";

export function TopBar() {
  const { data: s } = useSystemState();

  return (
    <header className="h-14 border-b border-border bg-card/40 backdrop-blur supports-[backdrop-filter]:bg-card/40 flex items-center px-3 gap-2 shrink-0">
      <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
      <div className="h-5 w-px bg-border" />

      {s && (
        <>
          {/* Money-mode indicator — driven by the real liveTradingEnabled
              switch. The only mode that matters: paper or live. */}
          <LiveModeIndicator liveTradingEnabled={s.liveTradingEnabled} />

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
