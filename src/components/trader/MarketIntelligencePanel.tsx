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

function momentumFreshnessMeta(brief: MarketIntelligence): { stale: boolean; cause?: string } {
  if (!brief.recentMomentumAt) {
    return { stale: true, cause: brief.recentMomentumNotes ?? "Momentum snapshot timestamp missing" };
  }

  const ageMs = Date.now() - new Date(brief.recentMomentumAt).getTime();
  const stale = Number.isNaN(ageMs) || ageMs > 2 * 60 * 60 * 1000;
  if (!stale) return { stale: false };

  const cause = [brief.recentMomentumNotes, brief.recentMomentum1h, brief.recentMomentum4h]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join(" · ");

  return { stale: true, cause: cause || `Momentum snapshot stale (${formatRelative(brief.recentMomentumAt)})` };
}

function SymbolBrief({ brief }: { brief: MarketIntelligence }) {
  const bias = biasMeta(brief.macroBias);
  const env = envMeta(brief.environmentRating);
  const BiasIcon = bias.icon;
  const momentumFreshness = momentumFreshnessMeta(brief);

  return (
    <div className="space-y-3">
      {momentumFreshness.stale && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive space-y-1">
          <p className="font-medium">Brain Trust refresh issue → momentum stale → signal gate block</p>
          {momentumFreshness.cause && (
            <p className="text-[11px] text-destructive/90">Cause: {momentumFreshness.cause}</p>
          )}
        </div>
      )}

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
              Three AI experts · refreshed every 4h
              {newest && <> · last run {formatRelative(newest.generatedAt)}</>}
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
              <TabsTrigger key={s} value={s} className="text-[11px]">
                {s.replace("-USD", "")}
              </TabsTrigger>
            ))}
          </TabsList>
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
