import { SectionHeader } from "@/components/trader/SectionHeader";
import { PriceChart } from "@/components/trader/PriceChart";
import { RegimeBadge } from "@/components/trader/RegimeBadge";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { ReasonChip } from "@/components/trader/ReasonChip";
import { AIInsightPanel } from "@/components/trader/AIInsightPanel";
import { JournalEventCard } from "@/components/trader/JournalEventCard";
import { generateCandles, journalEntries, marketRegime } from "@/mocks/data";

export default function MarketIntel() {
  const candles = generateCandles();
  const research = journalEntries.filter((j) => j.kind === "research" || j.kind === "skip");

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
              <RegimeBadge regime={marketRegime.regime} confidence={marketRegime.confidence} />
              <StatusBadge tone="neutral" size="sm">vol {marketRegime.volatility}</StatusBadge>
              <StatusBadge tone="safe" size="sm">spread {marketRegime.spread}</StatusBadge>
            </div>
            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
              <Stat label="Confidence" value={`${(marketRegime.confidence * 100).toFixed(0)}%`} />
              <Stat label="TOD score" value={`${(marketRegime.timeOfDayScore * 100).toFixed(0)}%`} />
              <Stat label="Setup score" value="0.42" />
              <Stat label="Threshold" value="0.65" />
            </div>
          </div>

          <div className="panel p-4 space-y-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">No-trade reasons</span>
            <div className="flex flex-wrap gap-1.5">
              {marketRegime.noTradeReasons.map((r) => (
                <ReasonChip key={r} label={r} tone="caution" />
              ))}
            </div>
            <p className="text-xs text-muted-foreground italic pt-2">
              No-trade is a valid outcome. The bot will not force entries.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <AIInsightPanel className="lg:col-span-2" title="Market summary" body={marketRegime.summary} timestamp="now" />
        <div className="panel p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Signal conditions</div>
          <div className="space-y-2 text-sm">
            <Cond label="MA cross" status="neutral" />
            <Cond label="Volume confirm" status="neutral" />
            <Cond label="Momentum > 0.5" status="bad" />
            <Cond label="Spread < 5 bps" status="ok" />
            <Cond label="TOD window" status="ok" />
          </div>
        </div>
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3">Research feed</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {research.map((e) => (
            <JournalEventCard key={e.id} entry={e} />
          ))}
        </div>
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
