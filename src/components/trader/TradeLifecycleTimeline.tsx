import { cn } from "@/lib/utils";
import { Check, Circle, Clock, Eye, Archive } from "lucide-react";
import type { TradePhase } from "@/mocks/types";

const phases: { key: TradePhase; label: string; icon: React.ReactNode }[] = [
  { key: "candidate", label: "Candidate", icon: <Circle className="h-3 w-3" /> },
  { key: "entered", label: "Entered", icon: <Check className="h-3 w-3" /> },
  { key: "monitored", label: "Monitored", icon: <Eye className="h-3 w-3" /> },
  { key: "exited", label: "Exited", icon: <Clock className="h-3 w-3" /> },
  { key: "archived", label: "Archived", icon: <Archive className="h-3 w-3" /> },
];

export function TradeLifecycleTimeline({ current, className }: { current: TradePhase; className?: string }) {
  const idx = phases.findIndex((p) => p.key === current);
  return (
    <div className={cn("flex items-center w-full", className)}>
      {phases.map((p, i) => {
        const reached = i <= idx;
        const active = i === idx;
        return (
          <div key={p.key} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={cn(
                  "h-7 w-7 rounded-full flex items-center justify-center border transition-colors",
                  reached
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : "bg-secondary border-border text-muted-foreground",
                  active && "ring-2 ring-primary/30",
                )}
              >
                {p.icon}
              </div>
              <span
                className={cn(
                  "text-[10px] uppercase tracking-wider",
                  reached ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {p.label}
              </span>
            </div>
            {i < phases.length - 1 && (
              <div
                className={cn(
                  "flex-1 h-px mx-2 -mt-4",
                  i < idx ? "bg-primary/40" : "bg-border",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
