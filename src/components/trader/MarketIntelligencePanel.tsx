// MarketIntelligencePanel — surfaces the cached "Brain Trust" brief for
// each whitelisted symbol. Three collapsible sections per symbol:
//   📊 Macro · 🧠 Crypto Context · 📈 Chart Context
// Backed by public.market_intelligence (refreshed by cron every 4h).

import { useMemo, useState } from "react";
import { Brain, ChevronDown, RefreshCw, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { useMarketIntelligence, type MarketIntelligence } from "@/hooks/useMarketIntelligence";
import { cn } from "@/lib/utils";

const SYMBOL_ORDER = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;
const MOMENTUM_STALE_MINUTES = 75;

type Tone = "long" | "short" | "neutral" | "warn" | "good";

function toneClasses(tone: Tone): string {
  switch (tone) {
    case "long":
    case "good":
      return "bg-success/10 text-success border-success/30";
    case "short":
    case "warn":
      return "bg-destructive/10 text-destructive border-destructive/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function biasMeta(bias: MarketIntelligence["macroBias"]): { label: string; tone: Tone; icon: typeof TrendingUp } {
  switch (bias) {
    case "strong_long":
      return { label: "Strong long", tone: "long", icon: TrendingUp };
    case "lean_long":
      return { label: "Lean long", tone: "long", icon: TrendingUp };
    case "lean_short":
      return { label: "Lean short", tone: "short", icon: TrendingDown };
    case "strong_short":
      return { label: "Strong short", tone: "short", icon: TrendingDown };
    default:
      return { label: "Neutral", tone: "neutral", icon: Minus };
  }
}

function envMeta(rating: MarketIntelligence["environmentRating"]): { label: string; tone: Tone } {
  switch (rating) {
    case "highly_favorable":
      return { label: "Highly favorable", tone: "good" };
    case "favorable":
      return { label: "Favorable", tone: "good" };
    case "unfavorable":
      return { label: "Unfavorable", tone: "warn" };
    case "highly_unfavorable":
      return { label: "Highly unfavorable", tone: "warn" };
    default:
      return { label: "Neutral", tone: "neutral" };
  }
}

function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function getMinutesAgo(iso: string | null): number | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((Date.now() - ts) / 60_000));
}

function momentumFreshnessMeta(brief?: MarketIntelligence): { label: string; tone: Tone; minutes: number | null } {
  const minutes = getMinutesAgo(brief?.recentMomentumAt ?? null);
  if (minutes == null) return { label: "No momentum", tone: "neutral", minutes: null };
  if (minutes <= MOMENTUM_STALE_MINUTES) return { label: "Momentum fresh", tone: "good", minutes };
  return { label: "Momentum stale", tone: "warn", minutes };
}

function SymbolBrief({ brief }: { brief: MarketIntelligence }) {
  const bias = biasMeta(brief.macroBias);
  const env = envMeta(brief.environmentRating);
  const BiasIcon = bias.icon;
  const momentum = momentumFreshnessMeta(brief);

  return (
    <div className="space-y-3">
      {/* Top-line badges */}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span
          className={cn(
            "inline-flex items-center gap-1 px-2 py-0.5 rounded-md border font-medium",
            toneClasses(bias.tone),
          )}
        >
          <BiasIcon className="h-3 w-3" /> {bias.label}
          <span className="opacity-70">· {Math.round(brief.macroConfidence * 100)}%</span>
        </span>
        <span
          className={cn(
            "inline-flex items-center px-2 py-0.5 rounded-md border font-medium",
            toneClasses(env.tone),
          )}
        >
          {env.label}
        </span>
        <span className="inline-flex items-center px-2 py-0.5 rounded-md border border-border bg-muted text-muted-foreground font-medium">
          {humanize(brief.marketPhase)}
        </span>
        <span className="inline-flex items-center px-2 py-0.5 rounded-md border border-border bg-muted text-muted-foreground font-medium">
          {humanize(brief.trendStructure)}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1 px-2 py-0.5 rounded-md border font-medium",
            toneClasses(momentum.tone),
          )}
        >
          {momentum.label}
          {momentum.minutes != null && <span className="opacity-70">· {momentum.minutes}m old</span>}
        </span>
      </div>

      {/* Macro */}
      <Collapsible defaultOpen>
        <CollapsibleTrigger className="group flex w-full items-center justify-between text-left">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">📊 Macro</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 space-y-2">
          <p className="text-sm leading-relaxed">{brief.macroSummary || <span className="italic text-muted-foreground">Awaiting first run…</span>}</p>
          {(brief.nearestSupport != null || brief.nearestResistance != null) && (
            <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              {brief.nearestSupport != null && (
                <span>
                  Support <span className="text-foreground font-mono">${brief.nearestSupport.toLocaleString()}</span>
                </span>
              )}
              {brief.nearestResistance != null && (
                <span>
                  Resistance <span className="text-foreground font-mono">${brief.nearestResistance.toLocaleString()}</span>
                </span>
              )}
            </div>
          )}
          {brief.keyLevelNotes && (
            <p className="text-xs text-muted-foreground italic">{brief.keyLevelNotes}</p>
          )}
        </CollapsibleContent>
      </Collapsible>

      {/* Crypto context */}
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center justify-between text-left">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">🧠 Crypto Context</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 space-y-2">
          <p className="text-sm leading-relaxed">
            {brief.sentimentSummary || <span className="italic text-muted-foreground">Awaiting first run…</span>}
          </p>
          <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            <span>
              Funding:{" "}
              <span className="text-foreground">{humanize(brief.fundingRateSignal)}</span>
              {brief.fundingRatePct != null && (
                <span className="font-mono opacity-70"> · {(brief.fundingRatePct * 100).toFixed(4)}%</span>
              )}
            </span>
            {brief.fearGreedScore != null && (
              <span>
                Fear & Greed:{" "}
                <span className="text-foreground">
                  {brief.fearGreedScore}/100
                  {brief.fearGreedLabel ? ` · ${brief.fearGreedLabel}` : ""}
                </span>
              </span>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Chart context */}
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center justify-between text-left">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">📈 Chart Context</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 space-y-2">
          {brief.patternContext ? (
            <p className="text-sm leading-relaxed">{brief.patternContext}</p>
          ) : (
            <p className="text-sm italic text-muted-foreground">Awaiting first run…</p>
          )}
          {brief.entryQualityContext && (
            <p className="text-xs text-muted-foreground leading-relaxed">{brief.entryQualityContext}</p>
          )}
          {(brief.recentMomentum1h != null ||
            brief.recentMomentum4h != null ||
            brief.recentMomentumNotes) && (
            <div className="rounded-md border border-border/70 bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                {brief.recentMomentum1h != null && (
                  <span>
                    1h momentum <span className="text-foreground font-mono">{brief.recentMomentum1h.toFixed(2)}</span>
                  </span>
                )}
                {brief.recentMomentum4h != null && (
                  <span>
                    4h momentum <span className="text-foreground font-mono">{brief.recentMomentum4h.toFixed(2)}</span>
                  </span>
                )}
              </div>
              {brief.recentMomentumNotes && <p className="italic">{brief.recentMomentumNotes}</p>}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

interface MarketIntelligencePanelProps {
  /** Optional: only render the brief for this symbol (no tabs). */
  symbol?: string;
  className?: string;
}

export function MarketIntelligencePanel({ symbol, className }: MarketIntelligencePanelProps) {
  const { data, loading, refreshing, refresh } = useMarketIntelligence();
  const [activeTab, setActiveTab] = useState<string>(symbol ?? SYMBOL_ORDER[0]);

  const briefsBySymbol = useMemo(() => {
    const m = new Map<string, MarketIntelligence>();
    data.forEach((b) => m.set(b.symbol, b));
    return m;
  }, [data]);

  const symbols = symbol ? [symbol] : SYMBOL_ORDER.slice();
  const activeBrief = briefsBySymbol.get(activeTab);

  const newest = useMemo(() => {
    if (data.length === 0) return null;
    return data.reduce((acc, b) =>
      !acc || new Date(b.generatedAt).getTime() > new Date(acc.generatedAt).getTime() ? b : acc,
    );
  }, [data]);

  const handleRefresh = async () => {
    const r = await refresh();
    if (r.ok) toast.success("Brain Trust refreshed.");
    else toast.error(r.error ?? "Refresh failed.");
  };

  return (
    <div className={cn("panel p-4 space-y-3", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">Market Intelligence</h3>
            <p className="text-[11px] text-muted-foreground">
              Three AI experts · momentum refreshes continuously, macro every few hours
              {newest && <> · macro {formatRelative(newest.generatedAt)}</>}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
          className="h-7 px-2 text-[11px]"
        >
          <RefreshCw className={cn("h-3 w-3 mr-1", refreshing && "animate-spin")} />
          {refreshing ? "Refreshing…" : "Refresh now"}
        </Button>
      </div>

      {loading ? (
        <p className="text-xs italic text-muted-foreground py-4 text-center">Loading brief…</p>
      ) : data.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center space-y-2">
          <p>No brief generated yet.</p>
          <p className="text-[11px]">
            The Brain Trust will run automatically every 4 hours, or hit Refresh to generate one now.
          </p>
        </div>
      ) : symbol ? (
        activeBrief ? (
          <SymbolBrief brief={activeBrief} />
        ) : (
          <p className="text-xs italic text-muted-foreground py-4 text-center">
            No brief for {symbol} yet.
          </p>
        )
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-3 h-8">
            {symbols.map((s) => (
              <TabsTrigger key={s} value={s} className="text-[11px] gap-1.5">
                <span>{s.replace("-USD", "")}</span>
                {(() => {
                  const freshness = momentumFreshnessMeta(briefsBySymbol.get(s));
                  return (
                    <span
                      className={cn(
                        "rounded border px-1 py-0 text-[10px] leading-4",
                        toneClasses(freshness.tone),
                      )}
                    >
                      {freshness.minutes == null ? "—" : `${freshness.minutes}m`}
                    </span>
                  );
                })()}
              </TabsTrigger>
            ))}
          </TabsList>
          <p className="pt-2 text-[10px] text-muted-foreground">
            Momentum freshness turns stale after {MOMENTUM_STALE_MINUTES} minutes.
          </p>
          {symbols.map((s) => {
            const b = briefsBySymbol.get(s);
            return (
              <TabsContent key={s} value={s} className="pt-3">
                {b ? (
                  <SymbolBrief brief={b} />
                ) : (
                  <p className="text-xs italic text-muted-foreground py-4 text-center">
                    No brief for {s} yet — try Refresh.
                  </p>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      )}
    </div>
  );
}
