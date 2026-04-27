import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronUp,
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
