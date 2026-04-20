import { cn } from "@/lib/utils";
import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import type { AlertSeverity } from "@/lib/domain-types";

const severityStyles: Record<AlertSeverity, { ring: string; text: string; icon: React.ReactNode }> = {
  info: { ring: "border-l-status-candidate/60", text: "text-status-candidate", icon: <Info className="h-4 w-4" /> },
  warning: { ring: "border-l-status-caution/70", text: "text-status-caution", icon: <AlertTriangle className="h-4 w-4" /> },
  critical: { ring: "border-l-status-blocked/80", text: "text-status-blocked", icon: <AlertCircle className="h-4 w-4" /> },
};

interface AlertBannerProps {
  severity: AlertSeverity;
  title: string;
  message: string;
  timestamp?: string;
  className?: string;
}

export function AlertBanner({ severity, title, message, timestamp, className }: AlertBannerProps) {
  const s = severityStyles[severity];
  return (
    <div
      className={cn(
        "flex gap-3 rounded-md border border-border bg-card/60 px-3 py-2.5 border-l-2",
        s.ring,
        className,
      )}
    >
      <div className={cn("mt-0.5", s.text)}>{s.icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-foreground truncate">{title}</p>
          {timestamp && <span className="text-[10px] uppercase tracking-wider text-muted-foreground tabular shrink-0">{timestamp}</span>}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{message}</p>
      </div>
    </div>
  );
}
