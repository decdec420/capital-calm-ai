import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Info,
  Play,
  RefreshCw,
  ShieldOff,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useAlerts } from "@/hooks/useAlerts";
import { useSystemState } from "@/hooks/useSystemState";
import type { Alert, AlertSeverity } from "@/lib/domain-types";
import { classifyAlert } from "@/lib/alert-classification";

const severityStyles: Record<
  AlertSeverity,
  { ring: string; tone: string; label: string; icon: React.ReactNode }
> = {
  info: {
    ring: "border-l-status-candidate/60",
    tone: "text-status-candidate",
    label: "Info",
    icon: <Info className="h-4 w-4" />,
  },
  warning: {
    ring: "border-l-status-caution/70",
    tone: "text-status-caution",
    label: "Warning",
    icon: <AlertTriangle className="h-4 w-4" />,
  },
  critical: {
    ring: "border-l-status-blocked/80",
    tone: "text-status-blocked",
    label: "Critical",
    icon: <AlertCircle className="h-4 w-4" />,
  },
};

function formatTimestamp(ts: string): { absolute: string; relative: string } {
  const d = new Date(ts);
  const absolute = d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const diffMs = Date.now() - d.getTime();
  const min = Math.max(0, Math.round(diffMs / 60000));
  let relative: string;
  if (min < 1) relative = "just now";
  else if (min < 60) relative = `${min} min ago`;
  else if (min < 60 * 24) relative = `${Math.round(min / 60)}h ago`;
  else relative = `${Math.round(min / 1440)}d ago`;
  return { absolute, relative };
}

export interface AlertCardProps {
  alert: Alert;
  /** When >1, indicates this card represents a collapsed group of similar info alerts. */
  groupCount?: number;
  /** Other alerts in the same group, shown when expanded. */
  groupMembers?: Alert[];
  onDismiss?: (id: string) => void;
  /** Bulk-dismiss all members of the group (incl. this one). */
  onDismissGroup?: (ids: string[]) => void;
}

export function AlertCard({
  alert,
  groupCount = 1,
  groupMembers,
  onDismiss,
  onDismissGroup,
}: AlertCardProps) {
  const [expanded, setExpanded] = useState(false);
  const sev = severityStyles[alert.severity];
  const cls = classifyAlert(alert);
  const { absolute, relative } = formatTimestamp(alert.timestamp);
  const isGroup = groupCount > 1;

  const toggle = () => setExpanded((x) => !x);

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-card/60 border-l-2",
        sev.ring,
      )}
    >
      {/* Header — always visible, click to expand */}
      <button
        type="button"
        onClick={toggle}
        className="w-full text-left px-3 py-2.5 flex gap-3 items-start hover:bg-accent/20 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        aria-expanded={expanded}
      >
        <div className={cn("mt-0.5 shrink-0", sev.tone)}>{sev.icon}</div>

        <div className="flex-1 min-w-0">
          {/* Meta row: severity · category · timestamp */}
          <div className="flex items-center gap-2 flex-wrap text-[10px] uppercase tracking-wider tabular">
            <span className={cn("font-medium", sev.tone)}>{sev.label}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{cls.categoryLabel}</span>
            <span className="text-muted-foreground ml-auto">
              {absolute} · {relative}
            </span>
          </div>

          {/* Title + group badge */}
          <div className="flex items-baseline gap-2 mt-0.5">
            <p className="text-sm font-medium text-foreground truncate">
              {alert.title}
            </p>
            {isGroup && (
              <span className="text-[10px] tabular px-1.5 py-0.5 rounded-sm bg-secondary text-muted-foreground shrink-0">
                ×{groupCount}
              </span>
            )}
          </div>

          {/* Collapsed summary */}
          {!expanded && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {cls.summary}
            </p>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0 mt-0.5">
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-border px-3 py-3 space-y-3">
          {cls.category === "cron_health" && <JessicaTriage />}

          <Section label="What" body={cls.what} />
          <Section label="Why it matters" body={cls.why} />

          {cls.fixes.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
                Fixes to look into
              </p>
              <ol className="text-xs text-foreground/90 space-y-1 list-decimal list-inside marker:text-muted-foreground">
                {cls.fixes.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ol>
            </div>
          )}

          {isGroup && groupMembers && groupMembers.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
                Occurrences ({groupCount})
              </p>
              <ul className="text-xs space-y-1 max-h-48 overflow-y-auto">
                {groupMembers.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-start gap-2 text-muted-foreground"
                  >
                    <span className="tabular text-[10px] shrink-0 pt-0.5">
                      {formatTimestamp(m.timestamp).absolute}
                    </span>
                    <span className="flex-1 text-foreground/80">{m.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-1">
            {cls.primaryAction && (
              <Button variant="outline" size="sm" asChild>
                <Link to={cls.primaryAction.to}>
                  {cls.primaryAction.label}
                  <ArrowRight className="h-3.5 w-3.5 ml-1" />
                </Link>
              </Button>
            )}
            {cls.secondaryAction && (
              <Button variant="ghost" size="sm" asChild>
                <Link to={cls.secondaryAction.to}>{cls.secondaryAction.label}</Link>
              </Button>
            )}
            {cls.category === "cron_health" && (
              <Button variant="ghost" size="sm" asChild>
                <Link to="/copilot">
                  Open Copilot for full agent panel
                  <ArrowRight className="h-3.5 w-3.5 ml-1" />
                </Link>
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              {isGroup && onDismissGroup && groupMembers ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDismissGroup([alert.id, ...groupMembers.map((m) => m.id)]);
                  }}
                >
                  <X className="h-3.5 w-3.5 mr-1" />
                  Dismiss all ({groupCount})
                </Button>
              ) : (
                onDismiss && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDismiss(alert.id);
                    }}
                  >
                    <X className="h-3.5 w-3.5 mr-1" />
                    Dismiss
                  </Button>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-0.5">
        {label}
      </p>
      <p className="text-xs text-foreground/90 whitespace-pre-wrap">{body}</p>
    </div>
  );
}

/**
 * Live triage block for cron_health alerts. Reads current system state
 * (bot, kill-switch, last Jessica decision) and the heartbeat agent_health
 * row, then offers the three actions that actually clear this class of
 * alert: resume bot, disarm kill-switch, run Jessica now.
 */
function JessicaTriage() {
  const { user } = useAuth();
  const { data: system, update, refetch } = useSystemState();
  const [hbStatus, setHbStatus] = useState<string | null>(null);
  const [hbError, setHbError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "resume" | "disarm" | "kick">(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("agent_health")
        .select("status,last_error")
        .eq("user_id", user.id)
        .eq("agent_name", "jessica_heartbeat")
        .maybeSingle();
      if (cancelled) return;
      setHbStatus(data?.status ?? null);
      setHbError(data?.last_error ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  if (!system) return null;

  const decision = system.lastJessicaDecision;
  const ranAt = decision?.ran_at ?? null;
  const ageSec = ranAt
    ? Math.floor((Date.now() - new Date(ranAt).getTime()) / 1000)
    : null;
  const ageLabel =
    ageSec === null
      ? "never"
      : ageSec < 60
        ? `${ageSec}s ago`
        : ageSec < 3600
          ? `${Math.floor(ageSec / 60)}m ago`
          : `${Math.floor(ageSec / 3600)}h ago`;
  const actions = (decision as any)?.actions ?? 0;

  const intentionallyIdle = system.bot !== "running" || system.killSwitchEngaged;
  const dotClass =
    hbStatus === "failed"
      ? "bg-status-blocked"
      : hbStatus === "degraded" || hbStatus === "stale"
        ? "bg-status-caution"
        : ageSec !== null && ageSec < 90
          ? "bg-status-safe"
          : "bg-muted-foreground/40";

  const onResume = async () => {
    setBusy("resume");
    try {
      await update({ bot: "running" });
      toast.success("Bot resumed.");
    } catch {
      toast.error("Couldn't resume the bot.");
    } finally {
      setBusy(null);
    }
  };

  const onDisarm = async () => {
    setBusy("disarm");
    try {
      await update({ killSwitchEngaged: false, bot: "paused" });
      toast.success("Kill-switch disarmed. Bot is paused — start it when ready.");
    } catch {
      toast.error("Couldn't disarm kill-switch.");
    } finally {
      setBusy(null);
    }
  };

  const onKick = async () => {
    setBusy("kick");
    try {
      const { data, error } = await supabase.functions.invoke("jessica");
      if (error) throw error;
      toast.success(
        `Jessica ticked${data?.actions != null ? ` · ${data.actions} action${data.actions === 1 ? "" : "s"}` : ""}.`,
      );
      await refetch();
      // refresh heartbeat row
      if (user) {
        const { data: hb } = await supabase
          .from("agent_health")
          .select("status,last_error")
          .eq("user_id", user.id)
          .eq("agent_name", "jessica_heartbeat")
          .maybeSingle();
        setHbStatus(hb?.status ?? null);
        setHbError(hb?.last_error ?? null);
      }
    } catch (e: any) {
      toast.error(`Run failed: ${e?.message ?? "edge function unreachable"}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-md border border-border bg-secondary/30 p-2.5 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className={cn("w-1.5 h-1.5 rounded-full", dotClass)} />
        <span className="font-medium text-foreground">Jessica</span>
        <span className="text-muted-foreground">·</span>
        <span className="tabular text-foreground/90">last tick {ageLabel}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground tabular">{actions} action{actions === 1 ? "" : "s"}</span>
      </div>
      <div className="text-[11px] text-muted-foreground tabular flex flex-wrap gap-x-3 gap-y-0.5">
        <span>
          Bot: <span className="text-foreground/90">{system.bot}</span>
        </span>
        <span>
          Kill-switch:{" "}
          <span className={system.killSwitchEngaged ? "text-status-blocked" : "text-foreground/90"}>
            {system.killSwitchEngaged ? "engaged" : "off"}
          </span>
        </span>
        <span>
          Heartbeat agent:{" "}
          <span
            className={
              hbStatus === "failed"
                ? "text-status-blocked"
                : hbStatus === "degraded" || hbStatus === "stale"
                  ? "text-status-caution"
                  : "text-foreground/90"
            }
          >
            {hbStatus ?? "unknown"}
          </span>
        </span>
      </div>

      {intentionallyIdle && (
        <p className="text-[11px] text-status-caution/90 bg-status-caution/10 rounded px-2 py-1">
          Bot is intentionally idle ({system.killSwitchEngaged ? "kill-switch engaged" : `bot ${system.bot}`}).
          The heartbeat will resume once you start the bot — this alert will clear on its own.
        </p>
      )}

      {hbError && !intentionallyIdle && (
        <p className="text-[11px] text-muted-foreground italic">{hbError}</p>
      )}

      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {system.bot !== "running" && !system.killSwitchEngaged && (
          <Button size="sm" variant="default" onClick={onResume} disabled={busy !== null}>
            <Play className="h-3.5 w-3.5 mr-1" />
            {busy === "resume" ? "Resuming…" : "Start bot"}
          </Button>
        )}
        {system.killSwitchEngaged && (
          <Button size="sm" variant="default" onClick={onDisarm} disabled={busy !== null}>
            <ShieldOff className="h-3.5 w-3.5 mr-1" />
            {busy === "disarm" ? "Disarming…" : "Disarm kill-switch"}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onKick} disabled={busy !== null}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1", busy === "kick" && "animate-spin")} />
          {busy === "kick" ? "Running…" : "Run Jessica now"}
        </Button>
      </div>
    </div>
  );
}

