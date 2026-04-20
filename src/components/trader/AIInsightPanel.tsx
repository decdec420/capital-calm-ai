import { cn } from "@/lib/utils";
import { Sparkles } from "lucide-react";

interface AIInsightPanelProps {
  title: string;
  body: string;
  timestamp?: string;
  className?: string;
  footer?: React.ReactNode;
}

export function AIInsightPanel({ title, body, timestamp, className, footer }: AIInsightPanelProps) {
  return (
    <div
      className={cn(
        "panel p-4 relative overflow-hidden",
        "before:absolute before:inset-0 before:bg-gradient-to-br before:from-primary/5 before:to-transparent before:pointer-events-none",
        className,
      )}
    >
      <div className="relative">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="h-6 w-6 rounded-md bg-primary/15 text-primary flex items-center justify-center">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <span className="text-[11px] uppercase tracking-wider text-primary/90 font-medium">AI Brief</span>
          </div>
          {timestamp && <span className="text-[10px] uppercase tracking-wider text-muted-foreground tabular">{timestamp}</span>}
        </div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">{body}</p>
        {footer && <div className="mt-3 pt-3 border-t border-border">{footer}</div>}
      </div>
    </div>
  );
}
