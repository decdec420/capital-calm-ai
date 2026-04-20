import { systemState } from "@/mocks/data";

export function StatusFooter() {
  const s = systemState;
  return (
    <footer className="h-7 border-t border-border bg-card/40 px-3 flex items-center gap-4 text-[10px] uppercase tracking-wider text-muted-foreground tabular shrink-0">
      <span>
        latency <span className="text-foreground/80">{s.latencyMs}ms</span>
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
        uptime <span className="text-foreground/80">{s.uptimeHours.toFixed(1)}h</span>
      </span>
      <div className="flex-1" />
      <span>BTC-USD · UTC {new Date().toUTCString().slice(17, 22)}</span>
    </footer>
  );
}
