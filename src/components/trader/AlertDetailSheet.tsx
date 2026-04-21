import { Link } from "react-router-dom";
import { ArrowRight, AlertCircle, AlertTriangle, Info } from "lucide-react";
import type { Alert, AlertSeverity } from "@/lib/domain-types";
import { MetricDrilldownSheet } from "./MetricDrilldownSheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const severityIcon: Record<AlertSeverity, { icon: React.ReactNode; tone: string; label: string }> = {
  info: { icon: <Info className="h-4 w-4" />, tone: "text-status-candidate", label: "Info" },
  warning: { icon: <AlertTriangle className="h-4 w-4" />, tone: "text-status-caution", label: "Warning" },
  critical: { icon: <AlertCircle className="h-4 w-4" />, tone: "text-status-blocked", label: "Critical" },
};

/**
 * Best-effort deep-link inferred from the alert text. Pure heuristic — no
 * schema change required. Maps common keywords to the page that owns them.
 */
function deepLinkFor(alert: Alert): { to: string; label: string } | null {
  const haystack = `${alert.title} ${alert.message}`.toLowerCase();
  if (/guardrail|loss cap|floor|kill[- ]?switch|cap reached/.test(haystack))
    return { to: "/risk", label: "Open Risk Center" };
  if (/trade|position|filled|stopped|tp1|exit|entry/.test(haystack))
    return { to: "/trades", label: "Open Trades" };
  if (/signal|copilot|ai/.test(haystack))
    return { to: "/copilot", label: "Open Copilot" };
  if (/journal|note|research/.test(haystack))
    return { to: "/journals", label: "Open Journals" };
  if (/regime|market|spread|volatility/.test(haystack))
    return { to: "/market", label: "Open Market Intel" };
  if (/mode|broker|connection|setting/.test(haystack))
    return { to: "/settings", label: "Open Settings" };
  return null;
}

export function AlertDetailSheet({
  alert,
  onClose,
  onDismiss,
}: {
  alert: Alert | null;
  onClose: () => void;
  onDismiss?: (id: string) => void;
}) {
  const open = !!alert;
  const meta = alert ? severityIcon[alert.severity] : null;
  const link = alert ? deepLinkFor(alert) : null;

  return (
    <MetricDrilldownSheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={
        alert && meta ? (
          <span className="flex items-center gap-2">
            <span className={meta.tone}>{meta.icon}</span>
            {alert.title}
          </span>
        ) : (
          "Alert"
        )
      }
      description={
        alert && meta ? (
          <span className={cn("uppercase tracking-wider text-[10px] font-medium", meta.tone)}>
            {meta.label}
          </span>
        ) : undefined
      }
    >
      {alert && (
        <>
          <div className="rounded-md border border-border bg-background/40 p-4">
            <p className="text-sm text-foreground whitespace-pre-wrap">{alert.message || "—"}</p>
          </div>
          <div className="text-[11px] text-muted-foreground tabular">
            {new Date(alert.timestamp).toLocaleString()}
          </div>
          <div className="flex gap-2 pt-2">
            {link && (
              <Button variant="outline" size="sm" asChild className="flex-1">
                <Link to={link.to} onClick={onClose}>
                  {link.label} <ArrowRight className="h-3.5 w-3.5 ml-1" />
                </Link>
              </Button>
            )}
            {onDismiss && (
              <Button
                variant="outline"
                size="sm"
                className="flex-1 text-muted-foreground"
                onClick={() => {
                  onDismiss(alert.id);
                  onClose();
                }}
              >
                Dismiss
              </Button>
            )}
          </div>
        </>
      )}
    </MetricDrilldownSheet>
  );
}
