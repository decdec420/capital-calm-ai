import { SectionHeader } from "@/components/trader/SectionHeader";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { AIInsightPanel } from "@/components/trader/AIInsightPanel";
import { MetricCard } from "@/components/trader/MetricCard";
import { experiments } from "@/mocks/data";
import { Brain, FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

const statusTone = {
  queued: "neutral",
  running: "candidate",
  accepted: "safe",
  rejected: "blocked",
} as const;

export default function Learning() {
  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Learning"
        title="Controlled optimization"
        description="The bot improves only through explicit, evidence-bound experiments."
        actions={
          <StatusBadge tone="accent" dot pulse>
            <Brain className="h-3 w-3" /> learning mode active
          </StatusBadge>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Experiments queued" value="2" icon={<FlaskConical className="h-3.5 w-3.5" />} />
        <MetricCard label="Accepted (30d)" value="3" tone="safe" />
        <MetricCard label="Rejected (30d)" value="5" tone="blocked" />
        <MetricCard label="Expectancy trend" value="+0.06R" delta={{ value: "+12%", direction: "up" }} tone="safe" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <AIInsightPanel
          className="lg:col-span-2"
          title="Weekly insight"
          body="Three of the last five experiments centered on stop-distance tuning. The accepted change (+0.1% stop) reduced false-loss exits by ~18%. Suggest next experiment: 3-bar volume confirmation on breakouts."
          timestamp="2h"
        />
        <div className="panel p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3">Expectancy (last 30 exp.)</div>
          <Sparkline values={[0.08, 0.1, 0.07, 0.12, 0.11, 0.14, 0.13, 0.16, 0.15, 0.18, 0.17, 0.2, 0.18, 0.22, 0.24]} />
        </div>
      </div>

      <div className="panel">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Experiment queue</span>
          <span className="text-xs text-muted-foreground tabular">{experiments.length} total</span>
        </div>
        <div className="divide-y divide-border">
          {experiments.map((e) => (
            <div key={e.id} className="px-4 py-3 flex items-center gap-3 flex-wrap">
              <StatusBadge tone={statusTone[e.status]} size="sm" dot>{e.status}</StatusBadge>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{e.title}</div>
                <div className="text-xs text-muted-foreground font-mono">
                  {e.parameter}: <span className="text-foreground/80">{e.before}</span> → <span className="text-primary">{e.after}</span>{" "}
                  <span className="text-muted-foreground">({e.delta})</span>
                </div>
                {e.notes && <div className="text-xs text-muted-foreground italic mt-0.5">{e.notes}</div>}
              </div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground tabular">
                {new Date(e.createdAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 300;
  const h = 80;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = w / (values.length - 1);
  const path = values.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - ((v - min) / range) * (h - 8) - 4).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: h }}>
      <defs>
        <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.3" />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${path} L${w},${h} L0,${h} Z`} fill="url(#spark)" />
      <path d={path} fill="none" stroke="hsl(var(--primary))" strokeWidth="1.5" />
    </svg>
  );
}
