import { useSystemState } from "@/hooks/useSystemState";
import { useTrades } from "@/hooks/useTrades";

// Mirrors doctrine.ts MAX_CORRELATED_POSITIONS — kept inline for a footer badge.
const MAX_CORRELATED_POSITIONS = 1;

export function StatusFooter() {
  const { data: s } = useSystemState();
  const { open } = useTrades();
  const openCount = open?.length ?? 0;
  const corrFull = openCount >= MAX_CORRELATED_POSITIONS;

  if (!s) {
    return (
      <footer className="h-7 border-t border-border bg-card/40 px-3 flex items-center gap-4 text-[10px] uppercase tracking-wider text-muted-foreground tabular shrink-0">
        <span>booting…</span>
        <div className="flex-1" />
        <span>BTC-USD · UTC {new Date().toUTCString().slice(17, 22)}</span>
      </footer>
    );
  }

  return (
    <footer className="h-7 border-t border-border bg-card/40 px-3 flex items-center gap-4 text-[10px] uppercase tracking-wider text-muted-foreground tabular shrink-0">
      <span>
        mode <span className="text-foreground/80 capitalize">{s.mode}</span>
      </span>
      <span className="h-3 w-px bg-border" />
      <span>
        feed <span className={s.dataFeed === "connected" ? "text-status-safe" : "text-status-blocked"}>{s.dataFeed}</span>
      </span>
      <span className="h-3 w-px bg-border" />
      <span title={s.mode === "paper" ? "Paper mode — no live broker is wired in" : undefined}>
        broker{" "}
        {s.mode === "paper" ? (
          <span className="text-muted-foreground">paper · none</span>
        ) : (
          <span className={s.brokerConnection === "connected" ? "text-status-safe" : "text-status-blocked"}>
            {s.brokerConnection}
          </span>
        )}
      </span>
      <span className="h-3 w-px bg-border" />
      <span>
        bot <span className="text-foreground/80">{s.bot}</span>
      </span>
      <span className="h-3 w-px bg-border" />
      <span title={corrFull ? "Correlation cap reached — engine will block new entries" : "Open correlated positions"}>
        corr{" "}
        <span className={corrFull ? "text-status-blocked" : "text-status-safe"}>
          {openCount}/{MAX_CORRELATED_POSITIONS}
        </span>
      </span>
      <div className="flex-1" />
      <span>BTC-USD · UTC {new Date().toUTCString().slice(17, 22)}</span>
    </footer>
  );
}
