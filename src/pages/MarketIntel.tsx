import { useMemo } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { PriceChart } from "@/components/trader/PriceChart";
import { RegimeBadge } from "@/components/trader/RegimeBadge";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { ReasonChip } from "@/components/trader/ReasonChip";
import { AIInsightPanel } from "@/components/trader/AIInsightPanel";
import { JournalEventCard } from "@/components/trader/JournalEventCard";
import { useCandles } from "@/hooks/useCandles";
import { useJournals } from "@/hooks/useJournals";
import { computeRegime } from "@/lib/regime";

export default function MarketIntel() {
  const { candles, loading } = useCandles();
  const { entries } = useJournals();
  const regime = useMemo(() => computeRegime("BTC-USD", candles), [candles]);
  const research = entries.filter((j) => j.kind === "research" || j.kind === "skip").slice(0, 6);

  if (loading || candles.length === 0) {
    return (
      <div className="space-y-6 animate-fade-in">
        <SectionHeader eyebrow="Market Intelligence" title="BTC-USD" description="Regime, signal quality, and observation feed." />
        <div className="panel p-12 text-center">
          <p className="text-sm text-muted-foreground italic">Pulling fresh candles…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader eyebrow="Market Intelligence" title="BTC-USD" description="Regime, signal quality, and observation feed." />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <PriceChart candles={candles} height={320} />
        </div>
        <div className="space-y-4">
          <div className="panel p-4 space-y-3">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Regime classification</span>
            <div className="flex flex-wrap items-center gap-2">
              <RegimeBadge regime={regime.regime} confidence={regime.confidence} />
              <StatusBadge tone="neutral" size="sm">vol {regime.volatility}</StatusBadge>
              <StatusBadge tone="safe" size="sm">spread {regime.spread}</StatusBadge>
            </div>
            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
              <Stat label="Confidence" value={`${(regime.confidence * 100).toFixed(0)}%`} />
              <Stat label="TOD score" value={`${(regime.timeOfDayScore * 100).toFixed(0)}%`} />
              <Stat label="Setup score" value={regime.setupScore.toFixed(2)} />
              <Stat label="Threshold" value="0.65" />
            </div>
          </div>

          <div className="panel p-4 space-y-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">No-trade reasons</span>
            {regime.noTradeReasons.length === 0 ? (
              <p className="text-xs text-status-safe italic">All clear — setup score crosses threshold.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {regime.noTradeReasons.map((r) => (
                  <ReasonChip key={r} label={r} tone="caution" />
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground italic pt-2">
              No-trade is a valid outcome. The bot will not force entries.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <AIInsightPanel className="lg:col-span-2" title="Market summary" body={regime.summary} timestamp="now" />
        <div className="panel p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Signal conditions</div>
          <div className="space-y-2 text-sm">
            <Cond label="Trend regime" status={regime.regime === "trending_up" || regime.regime === "breakout" ? "ok" : regime.regime === "chop" ? "bad" : "neutral"} />
            <Cond label="Vol normal" status={regime.volatility === "normal" ? "ok" : regime.volatility === "extreme" ? "bad" : "neutral"} />
            <Cond label="Setup ≥ 0.65" status={regime.setupScore >= 0.65 ? "ok" : "bad"} />
            <Cond label="Spread tight" status={regime.spread === "tight" ? "ok" : regime.spread === "wide" ? "bad" : "neutral"} />
            <Cond label="TOD window" status={regime.timeOfDayScore >= 0.6 ? "ok" : "neutral"} />
          </div>
        </div>
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3">Research feed</div>
        {research.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No research notes yet. Drop one from the Journals page.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {research.map((e) => (
              <JournalEventCard key={e.id} entry={e} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm tabular text-foreground">{value}</div>
    </div>
  );
}

function Cond({ label, status }: { label: string; status: "ok" | "neutral" | "bad" }) {
  const dot =
    status === "ok" ? "bg-status-safe" : status === "bad" ? "bg-status-blocked" : "bg-muted-foreground/40";
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
    </div>
  );
}
