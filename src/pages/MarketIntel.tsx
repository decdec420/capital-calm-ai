// ============================================================
// Market Intel — /market
// ------------------------------------------------------------
// The intelligence hub. Two data sources combined:
//   1. Live candles → browser-side regime (computeRegime)
//   2. Brain Trust  → AI-generated macro/sentiment/pattern
//      (Hall · Dollar Bill · Mafee, cached in market_intelligence)
//
// Multi-symbol: BTC · ETH · SOL tabs.
// All thresholds match the live engine (0.55 live).
// ============================================================

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Brain, RefreshCw, TrendingUp, TrendingDown, Minus, AlertTriangle, ChevronDown } from "lucide-react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { PriceChart } from "@/components/trader/PriceChart";
import { RegimeBadge } from "@/components/trader/RegimeBadge";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { ReasonChip } from "@/components/trader/ReasonChip";
import { JournalEventCard } from "@/components/trader/JournalEventCard";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "sonner";
import { useCandles } from "@/hooks/useCandles";
import { useJournals } from "@/hooks/useJournals";
import { useMarketIntelligence, type MarketIntelligence } from "@/hooks/useMarketIntelligence";
import { computeRegime, MIN_SETUP_SCORE_LIVE } from "@/lib/regime";
import { cn } from "@/lib/utils";

// ── Constants ─────────────────────────────────────────────────

const SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;
type SymbolId = (typeof SYMBOLS)[number];

function shortName(s: string) {
  return s.replace("-USD", "");
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function isStale(iso: string | null | undefined, maxMinutes = 10): boolean {
  if (!iso) return true;
  return Date.now() - new Date(iso).getTime() > maxMinutes * 60_000;
}

// ── Regime helpers ─────────────────────────────────────────────

function noTradeReasonLink(reason: string): { to: string; hint: string } {
  const r = reason.toLowerCase();
  if (/setup|score/.test(r)) return { to: "/risk", hint: "tune in Risk Center" };
  if (/vol|volatility/.test(r)) return { to: "/risk", hint: "vol guardrail" };
  if (/regime|chop|range/.test(r)) return { to: "/strategy", hint: "regime params" };
  if (/tod|time|liquidity/.test(r)) return { to: "/settings", hint: "time-of-day window" };
  return { to: "/risk", hint: "see guardrails" };
}

type Dot = "ok" | "neutral" | "bad";

function signalConditions(regime: ReturnType<typeof computeRegime>) {
  const tradeableRegime =
    regime.regime === "trending_up" ||
    regime.regime === "trending_down" ||
    regime.regime === "breakout" ||
    (regime.regime === "range" && (regime.rsiOverbought || regime.rsiOversold));

  return [
    {
      label: "Regime",
      detail:
        regime.regime === "range"
          ? regime.rsiOverbought
            ? `range · RSI ${regime.rsiNow.toFixed(0)} overbought → fade ↓`
            : regime.rsiOversold
            ? `range · RSI ${regime.rsiNow.toFixed(0)} oversold → fade ↑`
            : `range · RSI ${regime.rsiNow.toFixed(0)} (need ≥70 or ≤30)`
          : regime.regime.replace(/_/g, " "),
      status: (tradeableRegime ? "ok" : regime.regime === "chop" ? "bad" : "neutral") as Dot,
    },
    {
      label: "Volatility",
      detail: `${regime.volatility} · ${regime.annualizedVolPct.toFixed(0)}% ann.`,
      status: (
        regime.volatility === "normal" || regime.volatility === "low" ? "ok"
        : regime.volatility === "extreme" ? "bad"
        : "neutral"
      ) as Dot,
    },
    {
      label: `Setup ≥ ${MIN_SETUP_SCORE_LIVE}`,
      detail: `score ${regime.setupScore.toFixed(2)}`,
      status: (regime.setupScore >= MIN_SETUP_SCORE_LIVE ? "ok" : "bad") as Dot,
    },
    {
      label: "Pullback",
      detail: regime.pullback
        ? "detected — buy-the-dip entry"
        : `no · RSI ${regime.rsiNow.toFixed(0)}`,
      status: (regime.pullback ? "ok" : "neutral") as Dot,
    },
    {
      label: "TOD window",
      detail: `score ${(regime.timeOfDayScore * 100).toFixed(0)}%`,
      status: (
        regime.timeOfDayScore >= 0.55 ? "ok"
        : regime.timeOfDayScore < 0.4 ? "bad"
        : "neutral"
      ) as Dot,
    },
  ];
}

// ── Brain Trust helpers ────────────────────────────────────────

type Tone = "long" | "short" | "neutral" | "warn" | "good";

function toneClasses(tone: Tone) {
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

function biasMeta(bias: MarketIntelligence["macroBias"]) {
  switch (bias) {
    case "strong_long":  return { label: "Strong long",  tone: "long"    as Tone, Icon: TrendingUp };
    case "lean_long":    return { label: "Lean long",    tone: "long"    as Tone, Icon: TrendingUp };
    case "lean_short":   return { label: "Lean short",   tone: "short"   as Tone, Icon: TrendingDown };
    case "strong_short": return { label: "Strong short", tone: "short"   as Tone, Icon: TrendingDown };
    default:             return { label: "Neutral",      tone: "neutral" as Tone, Icon: Minus };
  }
}

function envMeta(rating: MarketIntelligence["environmentRating"]) {
  switch (rating) {
    case "highly_favorable":   return { label: "Highly favorable",   tone: "good" as Tone };
    case "favorable":          return { label: "Favorable",          tone: "good" as Tone };
    case "unfavorable":        return { label: "Unfavorable",        tone: "warn" as Tone };
    case "highly_unfavorable": return { label: "Highly unfavorable", tone: "warn" as Tone };
    default:                   return { label: "Neutral",            tone: "neutral" as Tone };
  }
}

function humanize(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fearGreedTone(score: number | null): Tone {
  if (score == null) return "neutral";
  if (score >= 75 || score <= 25) return "warn";
  if (score >= 55) return "long";
  if (score <= 45) return "short";
  return "neutral";
}

function fundingTone(signal: MarketIntelligence["fundingRateSignal"]): Tone {
  if (signal === "crowded_long" || signal === "crowded_short") return "warn";
  if (signal === "lean_long") return "long";
  if (signal === "lean_short") return "short";
  return "neutral";
}

// ── Shared small components ────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function Cond({ label, detail, status }: { label: string; detail: string; status: Dot }) {
  const dot =
    status === "ok" ? "bg-status-safe"
    : status === "bad" ? "bg-status-blocked"
    : "bg-muted-foreground/40";
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <div className="min-w-0">
        <span className="text-muted-foreground">{label}</span>
        <span className="ml-1.5 text-[11px] text-muted-foreground/60">{detail}</span>
      </div>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
    </div>
  );
}

function IntelBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium", toneClasses(tone))}>
      {children}
    </span>
  );
}

// ── Live Regime Panel ──────────────────────────────────────────

function RegimePanel({ symbol }: { symbol: SymbolId }) {
  const { candles, loading } = useCandles(symbol);
  const regime = useMemo(() => computeRegime(symbol, candles), [symbol, candles]);
  const conditions = useMemo(() => signalConditions(regime), [regime]);

  if (loading && candles.length === 0) {
    return (
      <div className="panel p-12 text-center">
        <p className="text-sm text-muted-foreground italic">Pulling candles for {shortName(symbol)}…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PriceChart candles={candles} height={240} />

      {/* Classification */}
      <div className="panel p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Live regime · {shortName(symbol)}
          </span>
          <Link to="/journals" className="text-[11px] text-primary hover:underline inline-flex items-center gap-0.5">
            journals <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <RegimeBadge regime={regime.regime} confidence={regime.confidence} />
          <StatusBadge tone="neutral" size="sm">vol {regime.volatility}</StatusBadge>
          <StatusBadge tone="neutral" size="sm">spread {regime.spread}</StatusBadge>
          {regime.pullback && <StatusBadge tone="safe" size="sm">pullback ✓</StatusBadge>}
          {regime.rsiOverbought && (
            <StatusBadge tone="caution" size="sm">RSI overbought {regime.rsiNow.toFixed(0)}</StatusBadge>
          )}
          {regime.rsiOversold && (
            <StatusBadge tone="caution" size="sm">RSI oversold {regime.rsiNow.toFixed(0)}</StatusBadge>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
          <Stat label="Confidence"  value={`${(regime.confidence * 100).toFixed(0)}%`} />
          <Stat label="TOD score"   value={`${(regime.timeOfDayScore * 100).toFixed(0)}%`} />
          <Stat label="Setup score" value={regime.setupScore.toFixed(2)} />
          <Stat label="Threshold"   value={String(MIN_SETUP_SCORE_LIVE)} />
          <Stat label="RSI"         value={regime.rsiNow.toFixed(1)} />
          <Stat label="Slow EMA ↑"  value={regime.slowRising ? "yes" : "no"} />
          {regime.emaSlow > 0 && <Stat label="Slow EMA" value={`$${regime.emaSlow.toFixed(0)}`} />}
          {regime.emaFast > 0 && <Stat label="Fast EMA" value={`$${regime.emaFast.toFixed(0)}`} />}
        </div>
      </div>

      {/* No-trade reasons */}
      {regime.noTradeReasons.length > 0 && (
        <div className="panel p-4 space-y-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">No-trade reasons</span>
          <div className="flex flex-wrap gap-1.5">
            {regime.noTradeReasons.map((r) => {
              const link = noTradeReasonLink(r);
              return (
                <Link key={r} to={link.to} title={link.hint} className="hover:opacity-80 transition-opacity">
                  <ReasonChip label={r} tone="caution" />
                </Link>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground italic pt-1">Click a reason to tune it.</p>
        </div>
      )}

      {/* Signal conditions */}
      <div className="panel p-4 space-y-2">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Signal conditions</span>
        <div className="space-y-1.5 pt-1">
          {conditions.map((c) => (
            <Cond key={c.label} label={c.label} detail={c.detail} status={c.status} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Brain Trust Panel ──────────────────────────────────────────

function BrainTrustPanel({
  brief,
  onRefresh,
  refreshing,
}: {
  brief: MarketIntelligence | undefined;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const stale = isStale(brief?.generatedAt, 10);

  if (!brief) {
    return (
      <div className="panel p-6 text-center space-y-3">
        <Brain className="h-8 w-8 text-muted-foreground mx-auto" />
        <p className="text-sm text-muted-foreground">No Brain Trust data yet for this symbol.</p>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={cn("h-3 w-3 mr-1.5", refreshing && "animate-spin")} />
          {refreshing ? "Running…" : "Run Brain Trust"}
        </Button>
      </div>
    );
  }

  const bias = biasMeta(brief.macroBias);
  const env  = envMeta(brief.environmentRating);
  const BiasIcon = bias.Icon;

  return (
    <div className="panel p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Brain className="h-4 w-4 text-primary shrink-0" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Brain Trust</h3>
            <p className="text-[11px] text-muted-foreground">
              Hall · Dollar Bill · Mafee
              <span className={cn("ml-1", stale ? "text-destructive/80" : "")}>
                {stale && <AlertTriangle className="inline h-2.5 w-2.5 mr-0.5 mb-0.5" />}
                · {formatRelative(brief.generatedAt)}
              </span>
            </p>
          </div>
        </div>
        <Button
          variant="outline" size="sm"
          onClick={onRefresh} disabled={refreshing}
          className="h-7 px-2 text-[11px] shrink-0"
        >
          <RefreshCw className={cn("h-3 w-3 mr-1", refreshing && "animate-spin")} />
          {refreshing ? "…" : "Refresh"}
        </Button>
      </div>

      {/* Top badges */}
      <div className="flex flex-wrap gap-1.5">
        <IntelBadge tone={bias.tone}>
          <BiasIcon className="h-3 w-3" />
          {bias.label}
          <span className="opacity-60">· {Math.round(brief.macroConfidence * 100)}%</span>
        </IntelBadge>
        <IntelBadge tone={env.tone}>{env.label}</IntelBadge>
        <IntelBadge tone="neutral">{humanize(brief.marketPhase)}</IntelBadge>
        <IntelBadge tone="neutral">{humanize(brief.trendStructure)}</IntelBadge>
      </div>

      {/* 📊 Macro — Hall */}
      <Collapsible defaultOpen>
        <CollapsibleTrigger className="group flex w-full items-center justify-between text-left">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">📊 Macro · Hall</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 space-y-2">
          <p className="text-sm leading-relaxed">
            {brief.macroSummary || <span className="italic text-muted-foreground">Awaiting first run…</span>}
          </p>
          {(brief.nearestSupport != null || brief.nearestResistance != null) && (
            <div className="flex flex-wrap gap-4 text-[11px] pt-1">
              {brief.nearestSupport != null && (
                <span className="text-muted-foreground">
                  Support <span className="text-foreground font-mono">${brief.nearestSupport.toLocaleString()}</span>
                </span>
              )}
              {brief.nearestResistance != null && (
                <span className="text-muted-foreground">
                  Resistance <span className="text-foreground font-mono">${brief.nearestResistance.toLocaleString()}</span>
                </span>
              )}
            </div>
          )}
          {brief.keyLevelNotes && (
            <p className="text-[11px] text-muted-foreground italic">{brief.keyLevelNotes}</p>
          )}
        </CollapsibleContent>
      </Collapsible>

      {/* 🧠 Sentiment — Dollar Bill */}
      <Collapsible defaultOpen>
        <CollapsibleTrigger className="group flex w-full items-center justify-between text-left">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">🧠 Sentiment · Dollar Bill</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 space-y-3">
          <p className="text-sm leading-relaxed">
            {brief.sentimentSummary || <span className="italic text-muted-foreground">Awaiting first run…</span>}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {brief.fearGreedScore != null && (
              <IntelBadge tone={fearGreedTone(brief.fearGreedScore)}>
                Fear &amp; Greed {brief.fearGreedScore}/100
                {brief.fearGreedLabel && <span className="opacity-70">· {brief.fearGreedLabel}</span>}
              </IntelBadge>
            )}
            <IntelBadge tone={fundingTone(brief.fundingRateSignal)}>
              Funding: {humanize(brief.fundingRateSignal)}
              {brief.fundingRatePct != null && (
                <span className="opacity-70 font-mono">
                  {" "}· {(brief.fundingRatePct * 100).toFixed(4)}%
                </span>
              )}
            </IntelBadge>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* 📈 Patterns — Mafee */}
      <Collapsible defaultOpen>
        <CollapsibleTrigger className="group flex w-full items-center justify-between text-left">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">📈 Patterns · Mafee</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 space-y-2">
          {brief.patternContext
            ? <p className="text-sm leading-relaxed">{brief.patternContext}</p>
            : <p className="text-sm italic text-muted-foreground">Awaiting first run…</p>
          }
          {brief.entryQualityContext && (
            <p className="text-[11px] text-muted-foreground leading-relaxed">{brief.entryQualityContext}</p>
          )}
          {(brief.recentMomentum1h != null || brief.recentMomentum4h != null) && (
            <div className="rounded-md border border-border/70 bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground flex flex-wrap gap-3">
              {brief.recentMomentum1h != null && (
                <span>1h momentum <span className="text-foreground font-mono">{brief.recentMomentum1h.toFixed(2)}</span></span>
              )}
              {brief.recentMomentum4h != null && (
                <span>4h momentum <span className="text-foreground font-mono">{brief.recentMomentum4h.toFixed(2)}</span></span>
              )}
              {brief.recentMomentumNotes && (
                <span className="italic w-full">{brief.recentMomentumNotes}</span>
              )}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────

export default function MarketIntel() {
  const [activeSymbol, setActiveSymbol] = useState<SymbolId>("BTC-USD");
  const { entries } = useJournals();
  const { data: briefs, refreshing, refresh } = useMarketIntelligence();

  const briefsBySymbol = useMemo(() => {
    const m = new Map<string, MarketIntelligence>();
    briefs.forEach((b) => m.set(b.symbol, b));
    return m;
  }, [briefs]);

  // Research journal entries only — skip entries are engine noise, not research notes
  const researchEntries = useMemo(
    () => entries.filter((j) => j.kind === "research").slice(0, 6),
    [entries],
  );

  const handleRefresh = async () => {
    const r = await refresh();
    if (r.ok) toast.success("Brain Trust refreshed.");
    else toast.error(r.error ?? "Refresh failed.");
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Market Intelligence"
        title="Regime · Brain Trust · Signals"
        description="Live candle regime alongside AI macro, sentiment, and pattern analysis from Hall, Dollar Bill, and Mafee — for all three symbols Bobby trades."
      />

      <Tabs value={activeSymbol} onValueChange={(v) => setActiveSymbol(v as SymbolId)}>
        <TabsList className="grid w-full grid-cols-3 h-9 max-w-xs">
          {SYMBOLS.map((s) => {
            const b = briefsBySymbol.get(s);
            const stale = isStale(b?.generatedAt, 10);
            return (
              <TabsTrigger key={s} value={s} className="text-[12px] gap-1.5">
                {shortName(s)}
                {b && (
                  <span className={cn(
                    "rounded border px-1 py-0 text-[10px] leading-4",
                    stale
                      ? "bg-destructive/10 text-destructive border-destructive/30"
                      : "bg-success/10 text-success border-success/30",
                  )}>
                    {stale ? "stale" : "live"}
                  </span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {SYMBOLS.map((s) => (
          <TabsContent key={s} value={s} className="mt-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <RegimePanel symbol={s} />
              <BrainTrustPanel
                brief={briefsBySymbol.get(s)}
                onRefresh={handleRefresh}
                refreshing={refreshing}
              />
            </div>
          </TabsContent>
        ))}
      </Tabs>

      {researchEntries.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Research notes</span>
            <Link to="/journals" className="text-[11px] text-primary hover:underline inline-flex items-center gap-0.5">
              All journals <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {researchEntries.map((e) => (
              <Link key={e.id} to="/journals" className="block hover:opacity-90 transition-opacity">
                <JournalEventCard entry={e} />
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
