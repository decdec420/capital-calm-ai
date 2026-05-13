import { CheckCircle2, Clock, RefreshCw, ShieldCheck, Sparkles, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuietModeStatus } from "@/hooks/useQuietModeStatus";
import { QUIET_MODE_SAFETY_COPY, type CleanupStatus, type QuietModeStatusMode } from "@/lib/quiet-mode-status";

function formatDateTime(value: string | null): string {
  if (!value) return "Not recorded";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(time));
}

function modeLabel(mode: QuietModeStatusMode): string {
  if (mode === "quiet") return "Quiet";
  if (mode === "normal") return "Normal";
  return "Unknown";
}

function cleanupLabel(status: CleanupStatus): string {
  if (status === "healthy") return "Healthy";
  if (status === "stale") return "Stale";
  if (status === "failed") return "Failed";
  return "Unknown";
}

function modeTone(mode: QuietModeStatusMode): string {
  if (mode === "quiet") return "bg-primary/10 text-primary border-primary/30";
  if (mode === "normal") return "bg-status-success/10 text-status-success border-status-success/30";
  return "bg-muted text-muted-foreground border-border";
}

function cleanupTone(status: CleanupStatus): string {
  if (status === "healthy") return "text-status-success";
  if (status === "stale") return "text-status-caution";
  if (status === "failed") return "text-status-blocked";
  return "text-muted-foreground";
}

function reasonText(reasonCodes: string[]): string {
  return reasonCodes.length > 0 ? reasonCodes.join(", ").replace(/_/g, " ") : "No recent Quiet Mode reason recorded";
}

export function QuietModeStatusTile() {
  const status = useQuietModeStatus();

  return (
    <div className="panel p-4 space-y-3 animate-fade-in" data-testid="quiet-mode-status-tile">
      <div className="flex items-start gap-2.5">
        <div className={cn("mt-0.5 shrink-0", status.mode === "quiet" ? "text-primary" : "text-muted-foreground")}>
          {status.mode === "quiet" ? <Sparkles className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
            Quiet Mode Status
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider", modeTone(status.mode))}>
              {status.loading ? "Loading" : modeLabel(status.mode)}
            </span>
            {status.isStale && (
              <span className="inline-flex items-center gap-1 text-[10px] text-status-caution">
                <AlertTriangle className="h-3 w-3" /> Stale
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={status.refetch}
          className="rounded border border-border bg-secondary px-2 py-1 text-[10px] text-muted-foreground hover:bg-secondary/80"
          aria-label="Refresh Quiet Mode status"
        >
          <RefreshCw className={cn("h-3 w-3", status.loading && "animate-spin")} />
        </button>
      </div>

      {status.error && (
        <div className="rounded bg-status-blocked/10 px-2 py-1.5 text-xs text-status-blocked">
          Failed to load Quiet Mode status: {status.error}
        </div>
      )}

      <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Last reason</div>
          <div className="font-medium leading-snug">{reasonText(status.latestReasonCodes)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Skipped workflow</div>
          <div className="font-medium leading-snug">
            {status.latestSkippedScope === "heavy_ai_only" ? "Heavy AI only" : "None recorded"}
            {status.latestSurface ? ` · ${status.latestSurface}` : ""}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Next check</div>
          <div className="font-medium leading-snug inline-flex items-center gap-1">
            <Clock className="h-3 w-3 text-muted-foreground" />
            {formatDateTime(status.nextRecommendedCheckAt)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Cleanup</div>
          <div className={cn("font-medium leading-snug", cleanupTone(status.cleanupStatus))}>
            {cleanupLabel(status.cleanupStatus)} · {formatDateTime(status.lastCleanupAt)}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border/50 pt-2 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <ShieldCheck className="h-3 w-3 text-status-success" />
          Safety checks preserved: {status.safetyChecksPreserved ? "yes" : "unknown"}
        </span>
        <span>Last quiet event: {formatDateTime(status.lastQuietEventAt)}</span>
        <span>Routine events deleted: {status.cleanupDeletedRoutineEventCount ?? "unknown"}</span>
        <span>Cron catalog: {status.cleanupCronConfigured === null ? "not exposed to app role" : status.cleanupCronConfigured ? "configured" : "not configured"}</span>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {QUIET_MODE_SAFETY_COPY}
      </p>
    </div>
  );
}
