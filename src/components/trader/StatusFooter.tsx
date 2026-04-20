import { useSystemState } from "@/hooks/useSystemState";

export function StatusFooter() {
  const { data: s } = useSystemState();

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
      <span>
        broker <span className={s.brokerConnection === "connected" ? "text-status-safe" : "text-status-blocked"}>{s.brokerConnection}</span>
      </span>
      <span className="h-3 w-px bg-border" />
      <span>
        bot <span className="text-foreground/80">{s.bot}</span>
      </span>
      <div className="flex-1" />
      <span>BTC-USD · UTC {new Date().toUTCString().slice(17, 22)}</span>
    </footer>
  );
}
