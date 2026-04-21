import { cn } from "@/lib/utils";
import { Check, Circle, Eye, Target, Archive, X, Clock } from "lucide-react";
import type {
  TradeLifecyclePhase,
  SignalLifecyclePhase,
  LifecycleTransition,
} from "@/lib/domain-types";

type AnyPhase = TradeLifecyclePhase | SignalLifecyclePhase;

const TRADE_PHASES: { key: TradeLifecyclePhase; label: string; icon: React.ReactNode }[] = [
  { key: "entered", label: "Entered", icon: <Check className="h-3 w-3" /> },
  { key: "monitored", label: "Monitored", icon: <Eye className="h-3 w-3" /> },
  { key: "tp1_hit", label: "TP1 hit", icon: <Target className="h-3 w-3" /> },
  { key: "exited", label: "Exited", icon: <Clock className="h-3 w-3" /> },
  { key: "archived", label: "Archived", icon: <Archive className="h-3 w-3" /> },
];

const SIGNAL_PHASES: { key: SignalLifecyclePhase; label: string; icon: React.ReactNode }[] = [
  { key: "proposed", label: "Proposed", icon: <Circle className="h-3 w-3" /> },
  { key: "approved", label: "Approved", icon: <Check className="h-3 w-3" /> },
  { key: "executed", label: "Executed", icon: <Target className="h-3 w-3" /> },
];

interface TradeLifecycleTimelineProps {
  current: AnyPhase;
  className?: string;
  // 'trade' (default) shows the trade lifecycle. 'signal' shows the signal one.
  kind?: "trade" | "signal";
  transitions?: LifecycleTransition[];
}

export function TradeLifecycleTimeline({
  current,
  className,
  kind = "trade",
  transitions,
}: TradeLifecycleTimelineProps) {
  // Terminal sub-states for signals: rejected/expired collapse the timeline.
  if (kind === "signal" && (current === "rejected" || current === "expired")) {
    return (
      <div className={cn("flex items-center gap-2 text-xs", className)}>
        <div className="h-7 w-7 rounded-full flex items-center justify-center border border-status-blocked/40 bg-status-blocked/10 text-status-blocked">
          <X className="h-3 w-3" />
        </div>
        <span className="uppercase tracking-wider text-status-blocked font-semibold">{current}</span>
      </div>
    );
  }

  const phases = kind === "signal" ? SIGNAL_PHASES : TRADE_PHASES;
  const idx = phases.findIndex((p) => p.key === current);
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center w-full">
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
      {transitions && transitions.length > 0 && (
        <details className="text-[10px] text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground transition-colors">
            Transition history · {transitions.length}
          </summary>
          <ul className="mt-1.5 space-y-0.5 pl-2 border-l border-border">
            {transitions.map((t, i) => (
              <li key={i} className="tabular">
                <span className="text-foreground">{t.phase}</span>
                <span> · {new Date(t.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                {t.by && <span> · by {t.by}</span>}
                {t.reason && <span className="text-muted-foreground/80"> — {t.reason}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

