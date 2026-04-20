import { cn } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";
import type { RiskGuardrail } from "@/mocks/types";

interface GuardrailRowProps {
  guardrail: RiskGuardrail;
  className?: string;
}

const levelTone = {
  safe: "safe",
  caution: "caution",
  blocked: "blocked",
} as const;

const barColor = {
  safe: "bg-status-safe",
  caution: "bg-status-caution",
  blocked: "bg-status-blocked",
} as const;

export function GuardrailRow({ guardrail, className }: GuardrailRowProps) {
  const pct = Math.min(100, Math.max(0, guardrail.utilization * 100));
  return (
    <div className={cn("panel p-4 space-y-3", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-foreground">{guardrail.label}</p>
            <StatusBadge tone={levelTone[guardrail.level]} size="sm" dot>
              {guardrail.level}
            </StatusBadge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{guardrail.description}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm tabular text-foreground">{guardrail.current}</div>
          <div className="text-[11px] text-muted-foreground tabular">limit {guardrail.limit}</div>
        </div>
      </div>
      <div className="h-1 w-full rounded-full bg-secondary overflow-hidden">
        <div className={cn("h-full transition-all", barColor[guardrail.level])} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
