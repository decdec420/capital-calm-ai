import { RefreshCw } from "lucide-react";
import { useCronHealth } from "@/hooks/useCronHealth";
import { cn } from "@/lib/utils";
import type { CronHealthRow, CronHealthSeverity } from "@/lib/cron-health";

const SUMMARY_COPY: Record<CronHealthSeverity, string> = {
  critical: "Critical attention needed",
  warning: "Warnings present",
  info: "Runs in progress",
  ok: "Cron OK",
};

function formatTime(value: string | null): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}


function formatExpectedWindow(row: CronHealthRow): string {
  if (!row.expectedEverySeconds) return "unknown";
  const every = row.expectedEverySeconds < 60
    ? `${row.expectedEverySeconds}s`
    : row.expectedEverySeconds < 3600
      ? `${Math.round(row.expectedEverySeconds / 60)}m`
      : `${Math.round(row.expectedEverySeconds / 3600)}h`;
  if (!row.lastRunAt) return `every ${every}`;
  const last = Date.parse(row.lastRunAt);
  if (!Number.isFinite(last)) return `every ${every}`;
  return `every ${every} · due ${formatTime(new Date(last + row.expectedEverySeconds * 1000).toISOString())}`;
}

function severityClass(severity: CronHealthSeverity): string {
  switch (severity) {
    case "critical": return "border-status-blocked/40 bg-status-blocked/10 text-status-blocked";
    case "warning": return "border-status-caution/40 bg-status-caution/10 text-status-caution";
    case "info": return "border-primary/30 bg-primary/10 text-primary";
    case "ok": return "border-emerald-500/30 bg-emerald-500/10 text-emerald-500";
  }
}

function CronRow({ row }: { row: CronHealthRow }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold text-foreground">{row.jobName}</span>
        <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {row.category.replace("_", " ")}
        </span>
        <span className={cn("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide", severityClass(row.severity))}>
          {row.severity}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-4">
        <div><span className="text-muted-foreground/60">Configured:</span> {row.configured ? "yes" : "no"}</div>
        <div><span className="text-muted-foreground/60">Last run:</span> {formatTime(row.lastRunAt)}</div>
        <div><span className="text-muted-foreground/60">Status:</span> {row.lastStatus}</div>
        <div><span className="text-muted-foreground/60">Stale:</span> {row.stale ? "yes" : "no"}</div>
        <div className="col-span-2 sm:col-span-4"><span className="text-muted-foreground/60">Expected:</span> {formatExpectedWindow(row)}</div>
      </div>
      {row.lastSafeMessage && <div className="text-[11px] text-muted-foreground">{row.lastSafeMessage}</div>}
    </div>
  );
}

export function CronHealthPanel() {
  const { loading, error, rows, summary, lastCheckedAt, refetch } = useCronHealth();
  const headlineSeverity: CronHealthSeverity = summary.critical > 0 ? "critical" : summary.warning > 0 ? "warning" : rows.length > 0 ? "ok" : "info";
  const visibleRows = rows.filter((row) => row.severity === "critical" || row.severity === "warning");
  const fallbackRows = visibleRows.length > 0 ? visibleRows : rows.slice(0, 4);

  return (
    <section className="panel p-4 space-y-4" aria-label="Cron Health">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Cron Health</h2>
            <span className={cn("rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide", severityClass(headlineSeverity))}>
              {SUMMARY_COPY[headlineSeverity]}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Critical {summary.critical} · Warning {summary.warning} · OK {summary.ok} · Unknown/info {summary.unknown}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground/80">
            Last checked {formatTime(lastCheckedAt)}. Raw cron commands and secrets are never shown.
          </p>
        </div>
        <button
          type="button"
          onClick={refetch}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {error && <div className="rounded-md border border-status-blocked/30 bg-status-blocked/10 p-2 text-xs text-status-blocked">{error}</div>}
      {loading && rows.length === 0 && <div className="text-xs text-muted-foreground">Loading cron health…</div>}
      {!loading && fallbackRows.length === 0 && !error && <div className="text-xs text-muted-foreground">No sanitized cron health rows returned.</div>}

      {fallbackRows.length > 0 && (
        <div className="grid gap-2">
          {fallbackRows.map((row) => <CronRow key={row.jobName} row={row} />)}
        </div>
      )}
    </section>
  );
}
