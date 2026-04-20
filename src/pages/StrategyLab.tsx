import { useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { StrategyVersionCard } from "@/components/trader/StrategyVersionCard";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { Button } from "@/components/ui/button";
import { strategies } from "@/mocks/data";
import { ArrowRight, Check, RotateCcw, X } from "lucide-react";

export default function StrategyLab() {
  const [selectedId, setSelectedId] = useState<string>(strategies.find((s) => s.status === "candidate")?.id ?? strategies[0].id);
  const candidate = strategies.find((s) => s.status === "candidate");
  const approved = strategies.find((s) => s.status === "approved");

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Strategy Lab"
        title="Versions & promotion"
        description="Strategies move forward only when evidence justifies it."
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {strategies.map((s) => (
          <StrategyVersionCard
            key={s.id}
            strategy={s}
            selected={selectedId === s.id}
            onSelect={() => setSelectedId(s.id)}
          />
        ))}
      </div>

      {approved && candidate && (
        <div className="panel p-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Promotion review</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-sm font-medium text-foreground">{approved.version}</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">{candidate.version}</span>
                <StatusBadge tone="candidate" size="sm" dot>candidate</StatusBadge>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="gap-1.5">
                <RotateCcw className="h-3.5 w-3.5" /> Send to paper
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5 text-status-blocked border-status-blocked/40 hover:bg-status-blocked/10 hover:text-status-blocked">
                <X className="h-3.5 w-3.5" /> Reject
              </Button>
              <Button size="sm" className="gap-1.5">
                <Check className="h-3.5 w-3.5" /> Promote
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ParamDiff title={approved.version} params={approved.params} other={candidate.params} side="left" />
            <ParamDiff title={candidate.version} params={candidate.params} other={approved.params} side="right" />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 pt-4 border-t border-border">
            <DiffMetric label="Expectancy" a={approved.metrics.expectancy} b={candidate.metrics.expectancy} suffix="R" />
            <DiffMetric label="Win rate" a={approved.metrics.winRate * 100} b={candidate.metrics.winRate * 100} suffix="%" />
            <DiffMetric label="Max DD" a={approved.metrics.maxDrawdown * 100} b={candidate.metrics.maxDrawdown * 100} suffix="%" inverse />
            <DiffMetric label="Sharpe" a={approved.metrics.sharpe} b={candidate.metrics.sharpe} />
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Trades</div>
              <div className="text-sm tabular text-foreground">{candidate.metrics.trades} <span className="text-muted-foreground">/ 50 needed</span></div>
            </div>
          </div>

          <div className="rounded-md bg-status-blocked/5 border border-status-blocked/20 p-3 flex items-start gap-3">
            <StatusBadge tone="blocked" size="sm" dot>gating</StatusBadge>
            <p className="text-xs text-muted-foreground">
              Promotion requires ≥50 paper trades on the candidate (currently {candidate.metrics.trades}) and explicit operator approval.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ParamDiff({ title, params, other, side }: { title: string; params: { key: string; value: any; unit?: string }[]; other: { key: string; value: any }[]; side: "left" | "right" }) {
  const otherMap = new Map(other.map((p) => [p.key, p.value]));
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">{title}</div>
      <div className="space-y-1.5">
        {params.map((p) => {
          const otherVal = otherMap.get(p.key);
          const changed = otherVal !== p.value;
          return (
            <div key={p.key} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground font-mono text-xs">{p.key}</span>
              <span className={`tabular ${changed && side === "right" ? "text-primary font-medium" : "text-foreground"}`}>
                {String(p.value)}{p.unit ?? ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffMetric({ label, a, b, suffix = "", inverse = false }: { label: string; a: number; b: number; suffix?: string; inverse?: boolean }) {
  const delta = b - a;
  const better = inverse ? delta < 0 : delta > 0;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm tabular text-foreground">
        {b.toFixed(2)}{suffix}{" "}
        <span className={`text-xs ${better ? "text-status-safe" : delta === 0 ? "text-muted-foreground" : "text-status-blocked"}`}>
          ({delta >= 0 ? "+" : ""}{delta.toFixed(2)})
        </span>
      </div>
    </div>
  );
}
