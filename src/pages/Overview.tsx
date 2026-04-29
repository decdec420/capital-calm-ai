import { useEffect, useMemo, useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { MetricCard } from "@/components/trader/MetricCard";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { RegimeBadge } from "@/components/trader/RegimeBadge";
import { AIInsightPanel } from "@/components/trader/AIInsightPanel";
import { DailyBriefPanel } from "@/components/trader/DailyBriefPanel";
import { DeskRosterStrip } from "@/components/trader/DeskRosterStrip";
import { DoctrineProposalBanner } from "@/components/trader/DoctrineProposalBanner";
import { MarketIntelligencePanel } from "@/components/trader/MarketIntelligencePanel";
import { useStrategies } from "@/hooks/useStrategies";

import { GuardrailRow } from "@/components/trader/GuardrailRow";
import { KillSwitchDialog } from "@/components/trader/KillSwitchDialog";
import { GateReasonList } from "@/components/trader/GateReasonRow";
import { MetricDrilldowns, type DrilldownKind } from "@/components/trader/MetricDrilldowns";

import { BrokerStatusInline } from "@/components/trader/BrokerStatusInline";
import { Button } from "@/components/ui/button";
import {
  Activity,
  ArrowRight,
  DollarSign,
  Pause,
  Play,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useAccountState } from "@/hooks/useAccountState";
import { useSystemState } from "@/hooks/useSystemState";
import { useTrades } from "@/hooks/useTrades";

import { useGuardrails } from "@/hooks/useGuardrails";
import { useCandles } from "@/hooks/useCandles";
import { useSignals } from "@/hooks/useSignals";
import { computeRegime } from "@/lib/regime";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Brain } from "lucide-react";
import { useRelativeTime, isStale } from "@/hooks/useRelativeTime";
import type { Regime } from "@/lib/domain-types";
import { DOCTRINE } from "@/lib/doctrine-constants";

function FreshnessDot({ timestamp }: { timestamp: number | null }) {
  const label = useRelativeTime(timestamp);
  const stale = isStale(timestamp);
  const tone = stale ? "text-status-caution" : "text-muted-foreground";
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[10px] ${tone}`}>
      <span
        className={`inline-block rounded-full ${stale ? "bg-status-caution" : "bg-muted-foreground"}`}
        style={{ width: 5, height: 5 }}
      />
      {label}
    </span>
  );
}

export default function Overview() {
  const { data: account, lastUpdatedAt: accountUpdatedAt, loading: accountLoading } = useAccountState();
  const { data: system, update: updateSystem } = useSystemState();
  const { approved: approvedStrategy, candidates: candidateStrategies } = useStrategies();
  const { open, closed } = useTrades();
  
  const { guardrails } = useGuardrails();
  const { candles } = useCandles();
  const { pending: pendingSignals } = useSignals();
  const [brief, setBrief] = useState<string>("");
  const [briefLoading, setBriefLoading] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const [drilldown, setDrilldown] = useState<DrilldownKind | null>(null);
  
  const activeSignal = pendingSignals[0];

  // Snapshot is the source of truth. Local computeRegime is the fallback
  // if the engine has never ticked yet (e.g. first-load before first run).
  const snapshot = system?.lastEngineSnapshot ?? null;
  const localRegime = useMemo(() => computeRegime("BTC-USD", candles), [candles]);
  const btcSnap = snapshot?.perSymbol.find((p) => p.symbol === "BTC-USD") ?? null;
  const regime = btcSnap
    ? {
        regime: (btcSnap.regime as Regime) ?? localRegime.regime,
        confidence: btcSnap.confidence,
        setupScore: btcSnap.setupScore,
      }
    : { regime: localRegime.regime, confidence: localRegime.confidence, setupScore: localRegime.setupScore };
  const lastGateReasons = snapshot?.gateReasons ?? [];
  const lastPrice = btcSnap?.lastPrice ?? candles[candles.length - 1]?.c ?? 0;
  const firstPrice = candles[0]?.c ?? lastPrice;
  const pctChange = firstPrice ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;

  const openPosition = open[0];
  const closedToday = closed.filter((t) => t.closedAt && new Date(t.closedAt).toDateString() === new Date().toDateString());
  const realizedToday = closedToday.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const unrealizedToday = open.reduce((sum, t) => sum + (t.unrealizedPnl ?? 0), 0);
  const lossToday = Math.min(0, realizedToday);


  const lastCandleTime = candles[candles.length - 1]?.t != null ? candles[candles.length - 1].t * 1000 : null;

  const dailyPnl = account ? account.equity - account.startOfDayEquity : 0;
  const dailyPnlPct = account && account.startOfDayEquity ? (dailyPnl / account.startOfDayEquity) * 100 : 0;
  const floorDistance = account ? ((account.equity - account.balanceFloor) / account.equity) * 100 : 0;
  const lossVsCap = account ? (Math.abs(lossToday) / account.startOfDayEquity) * 100 : 0;

  // Cumulative equity trail across the most recent N closed trades.
  // Mirrors the EquityDrilldown computation so the spark line and the
  // drilldown chart agree.
  const equitySeries = useMemo(() => {
    if (!account) return [] as number[];
    const sorted = [...closed]
      .filter((t) => t.closedAt)
      .sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime());
    const startEquity = account.equity - sorted.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const out: number[] = [startEquity];
    let running = startEquity;
    for (const t of sorted) {
      running += t.pnl ?? 0;
      out.push(running);
    }
    return out;
  }, [account, closed]);

  const tradesTodayCount = closedToday.length + open.length;
  const tradesCap = DOCTRINE.MAX_TRADES_PER_DAY;
  const winsToday = closedToday.filter((t) => (t.pnl ?? 0) > 0).length;
  const lossesToday = closedToday.filter((t) => (t.pnl ?? 0) < 0).length;

  // Adaptive precision: when amounts are small (typical for tiny paper accounts
  // or fractional crypto sizing), 2 decimals hides all the action. Show 4
  // decimals below $1 and 2 decimals above. Equity always at 2.
  const fmtMoney = (n: number, alwaysTwo = false) => {
    const abs = Math.abs(n);
    const digits = alwaysTwo ? 2 : abs < 1 ? 4 : 2;
    return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };


  const requestBrief = async () => {
    setBriefLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Sign in first.");
        return;
      }
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/market-brief`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
          regime: regime.regime,
          lastPrice: lastPrice.toFixed(2),
          pctChange: pctChange.toFixed(2),
          openTradesCount: open.length,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (res.status === 429) toast.error("Rate limit reached. Try again in a moment.");
        else if (res.status === 402) toast.error("AI credits depleted. Top up in Workspace usage.");
        else toast.error(json.error ?? "Brief failed");
        return;
      }
      setBrief(json.brief);
    } catch {
      toast.error("Couldn't reach the brief service.");
    } finally {
      setBriefLoading(false);
    }
  };

  // Auto-fetch brief once on mount when we have candles
  useEffect(() => {
    if (candles.length > 0 && !brief && !briefLoading) requestBrief();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles.length]);

  const toggleBot = async () => {
    if (!system) return;
    if (system.killSwitchEngaged && system.bot !== "running") {
      toast.error("Kill-switch is engaged. Disarm it before starting the bot.");
      return;
    }
    const next = system.bot === "running" ? "paused" : "running";
    try {
      await updateSystem({ bot: next });
      toast.success(`Bot ${next}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't toggle bot.");
    }
  };

  const liveGated = !system?.liveTradingEnabled;

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Mission Control"
        title="Overview"
        description="Calm, decisive view of the bot, the market, and your guardrails."
        actions={
          <>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={toggleBot}>
              {system?.bot === "running" ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {system?.bot === "running" ? "Pause bot" : "Resume bot"}
            </Button>
            <Button size="sm" className="gap-1.5" onClick={requestBrief} disabled={briefLoading}>
              <Sparkles className="h-3.5 w-3.5" /> {briefLoading ? "Briefing…" : "Request brief"}
            </Button>
          </>
        }
      />

      {system && (
        <BrokerStatusInline
          connection={system.brokerConnection}
          liveArmed={system.liveTradingEnabled}
        />
      )}

      {/* Trading pause — shown inline in DailyBriefPanel above */}

      {/* Hero strip */}
      <div className="panel p-5 flex flex-wrap items-center gap-4 bg-gradient-surface">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-md bg-primary/15 text-primary flex items-center justify-center">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">System mode</div>
            <div className="text-base font-semibold text-foreground capitalize">{system?.mode ?? "—"}</div>
          </div>
        </div>
        <div className="h-10 w-px bg-border hidden md:block" />
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Market regime</div>
          <div className="mt-1">
            <RegimeBadge regime={regime.regime} confidence={regime.confidence} />
          </div>
        </div>
        <div className="h-10 w-px bg-border hidden md:block" />
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Risk posture</div>
          <div className="mt-1">
            <StatusBadge tone={floorDistance > 2 ? "safe" : "caution"} dot>
              {floorDistance > 2 ? "capital protected" : "near floor"}
            </StatusBadge>
          </div>
        </div>
        <div className="flex-1" />
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">BTC-USD live</div>
          <div className="flex items-center justify-end gap-2">
            <span className="text-sm font-medium text-foreground tabular">
              ${lastPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
            <FreshnessDot timestamp={lastCandleTime} />
          </div>
          <div className={`text-[11px] tabular ${pctChange >= 0 ? "text-status-safe" : "text-status-blocked"}`}>
            {pctChange >= 0 ? "+" : ""}
            {pctChange.toFixed(2)}% window
          </div>
        </div>
      </div>

      {/* Pending signal banner */}
      {activeSignal && (
        <Link
          to="/copilot"
          className="panel p-4 flex items-center gap-4 border-primary/40 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent hover:border-primary/60 transition-colors group animate-fade-in"
        >
          <div className="h-10 w-10 rounded-md bg-primary/20 text-primary flex items-center justify-center shrink-0">
            <Brain className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] uppercase tracking-wider text-primary font-semibold">AI signal pending</span>
              <StatusBadge tone={activeSignal.side === "long" ? "safe" : "blocked"} size="sm" dot>
                {activeSignal.side}
              </StatusBadge>
              <span className="text-[10px] text-muted-foreground tabular">
                {(activeSignal.confidence * 100).toFixed(0)}% conf
              </span>
            </div>
            <div className="text-sm font-medium text-foreground truncate">
              {activeSignal.side.toUpperCase()} {activeSignal.symbol} @ ${activeSignal.proposedEntry.toFixed(2)}
              <span className="text-muted-foreground"> — {activeSignal.aiReasoning.slice(0, 80)}{activeSignal.aiReasoning.length > 80 ? "…" : ""}</span>
            </div>
          </div>
          <div className="text-xs text-primary group-hover:translate-x-0.5 transition-transform shrink-0 hidden sm:block">
            Review →
          </div>
        </Link>
      )}

      {/* Why isn't the bot trading? — surfaced from the last engine snapshot */}
      {!activeSignal && lastGateReasons.length > 0 && (
        <div className="panel p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">
              Why the engine is sitting on hands
            </span>
            {snapshot && (
              <span className="text-[10px] text-muted-foreground tabular">
                last tick {new Date(snapshot.ranAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
          </div>
          <GateReasonList reasons={lastGateReasons} max={3} />
          <Link to="/copilot" className="text-xs text-primary hover:underline inline-block">
            Open Copilot to act →
          </Link>
        </div>
      )}

      {/* Metric grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricCard
          label="Equity"
          value={account ? `$${fmtMoney(account.equity, true)}` : "—"}
          icon={<DollarSign className="h-3.5 w-3.5" />}
          hint={account ? `cash $${fmtMoney(account.cash, true)}` : undefined}
          sparkValues={equitySeries.slice(-10)}
          sublabel={closed.length > 0 ? `${closed.length} total trades` : undefined}
          explain={
            account ? (
              <>
                Total account value: cash + open positions marked-to-market.
                <br />
                Realized today: ${fmtMoney(realizedToday)} · Unrealized: ${fmtMoney(unrealizedToday)}
              </>
            ) : (
              "Total account value: cash + open positions marked-to-market."
            )
          }
          onClick={() => setDrilldown("equity")}
          loading={accountLoading}
          freshness={<FreshnessDot timestamp={accountUpdatedAt} />}
        />
        <MetricCard
          label="Daily PnL"
          value={`${dailyPnl >= 0 ? "+" : "-"}$${fmtMoney(Math.abs(dailyPnl))}`}
          delta={{ value: `${dailyPnlPct >= 0 ? "+" : ""}${dailyPnlPct.toFixed(2)}%`, direction: dailyPnl >= 0 ? "up" : "down" }}
          tone={dailyPnl >= 0 ? "safe" : "blocked"}
          icon={dailyPnl >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
          progress={
            dailyPnl < 0
              ? { value: Math.abs(lossVsCap), max: 1.5, tone: lossVsCap > 1 ? "blocked" : "caution" }
              : undefined
          }
          sublabel={
            closedToday.length > 0
              ? `${winsToday}W / ${lossesToday}L today`
              : "no closed trades yet"
          }
          explain="Profit & Loss since the start-of-day equity snapshot. Resets daily at 00:05 UTC via automatic rollover."
          onClick={() => setDrilldown("dailyPnl")}
          loading={accountLoading}
        />
        <MetricCard
          label="Trades today"
          value={String(tradesTodayCount)}
          hint={`cap ${tradesCap}`}
          progress={{ value: tradesTodayCount, max: tradesCap, tone: "safe" }}
          sublabel={
            open.length > 0
              ? `${open.length} open · ${closedToday.length} closed`
              : `${closedToday.length} closed`
          }
          explain={`Open + closed positions opened today. Hard cap of ${tradesCap} to stop revenge-trading after a bad fill.`}
          onClick={() => setDrilldown("tradesToday")}
          loading={accountLoading}
        />
        <MetricCard
          label="Loss vs cap"
          value={`${lossVsCap.toFixed(2)}%`}
          hint="cap 1.50%"
          tone={lossVsCap > 1 ? "caution" : "safe"}
          progress={{
            value: lossVsCap,
            max: 1.5,
            tone: lossVsCap > 1 ? "blocked" : lossVsCap > 0.75 ? "caution" : "safe",
          }}
          sublabel={lossToday < 0 ? `$${Math.abs(lossToday).toFixed(4)} used` : "no losses today"}
          explain="How much of today's max-loss budget you've already burned. At 100% the bot halts itself for the day."
          onClick={() => setDrilldown("lossVsCap")}
          loading={accountLoading}
        />
        <MetricCard
          label="Floor distance"
          value={account ? `${floorDistance.toFixed(1)}%` : "—"}
          hint={account ? `floor $${fmtMoney(account.balanceFloor, true)}` : undefined}
          progress={{
            value: floorDistance,
            max: 100,
            tone: floorDistance < 5 ? "blocked" : floorDistance < 15 ? "caution" : "safe",
          }}
          sublabel={account ? `floor $${account.balanceFloor.toFixed(2)}` : undefined}
          explain="How far equity sits above the absolute balance floor. Hit the floor and the kill-switch trips automatically."
          onClick={() => setDrilldown("floorDistance")}
          loading={accountLoading}
        />

        <MetricCard
          label="Live mode"
          value={liveGated ? "Gated" : "Armed"}
          icon={<ShieldAlert className="h-3.5 w-3.5" />}
          tone={liveGated ? "blocked" : "safe"}
          hint={liveGated ? "paper-only" : "operator-armed"}
          sublabel={liveGated ? "arm in Settings →" : "real orders allowed"}
          explain="Gated = paper money only, no real orders. Armed = real orders allowed (still subject to every guardrail). Toggle in Settings."
          onClick={() => setDrilldown("liveMode")}
          loading={accountLoading}
        />
      </div>

      {/* Two-column body */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <DoctrineProposalBanner />

          <DailyBriefPanel
            jessicaDecision={system?.lastJessicaDecision ?? null}
            pendingSignalsCount={pendingSignals.length}
            tradingPausedUntil={system?.tradingPausedUntil ?? null}
            pauseReason={system?.pauseReason ?? null}
          />

          <AIInsightPanel
            title="Today's market brief"
            body={brief || (briefLoading ? "Cooking up a brief…" : "No brief yet. Tap Request brief.")}
            timestamp={brief ? "now" : undefined}
            loading={briefLoading && !brief}
            footer={
              <Link to="/copilot" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
                Open Copilot <Zap className="h-3 w-3" />
              </Link>
            }
          />

          <MarketIntelligencePanel />

          <DeskRosterStrip
            approved={approvedStrategy}
            candidates={candidateStrategies}
          />

          {openPosition && (
            <Link
              to="/trades"
              className="panel p-4 space-y-3 block group hover:border-primary/40 transition-colors"
              aria-label="Open position — view in Trades"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">Open position</span>
                  <StatusBadge tone="candidate" size="sm" dot pulse>
                    monitoring
                  </StatusBadge>
                </div>
                <span className="text-xs text-primary inline-flex items-center gap-0.5 group-hover:translate-x-0.5 transition-transform">
                  Open in Trades <ArrowRight className="h-3 w-3" />
                </span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <PosCell label="Symbol" value={openPosition.symbol} />
                <PosCell label="Side" value={openPosition.side.toUpperCase()} />
                <PosCell label="Entry" value={`$${openPosition.entryPrice.toFixed(2)}`} />
                <PosCell label="Stop" value={openPosition.stopLoss !== null ? `$${openPosition.stopLoss.toFixed(2)}` : "—"} />
                <PosCell label="TP" value={openPosition.takeProfit !== null ? `$${openPosition.takeProfit.toFixed(2)}` : "—"} />
              </div>
            </Link>
          )}
        </div>

        <div className="space-y-4">
          <div className="panel p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">Kill-switches</span>
              <StatusBadge tone={system?.killSwitchEngaged ? "blocked" : "safe"} size="sm" dot>
                {system?.killSwitchEngaged ? "engaged" : "armed"}
              </StatusBadge>
            </div>
            {guardrails.slice(-3).map((g) => (
              <GuardrailRow key={g.id} guardrail={g} className="!p-3" />
            ))}
            <Link to="/risk" className="block text-xs text-primary hover:underline pt-1">
              View all guardrails →
            </Link>
          </div>

          <div className="panel p-4 space-y-2">
            <span className="text-sm font-medium text-foreground">Quick actions</span>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link to="/trades">Log trade</Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to="/journals">Journal</Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link to="/risk">Risk center</Link>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-status-blocked border-status-blocked/40 hover:bg-status-blocked/10 hover:text-status-blocked"
                onClick={() => setKillOpen(true)}
              >
                {system?.killSwitchEngaged ? "Disarm" : "Halt bot"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <KillSwitchDialog
        open={killOpen}
        onOpenChange={setKillOpen}
        engaged={!!system?.killSwitchEngaged}
        onConfirm={async () => {
          if (!system) return;
          const v = !system.killSwitchEngaged;
          try {
            await updateSystem({ killSwitchEngaged: v, bot: v ? "halted" : "paused" });
            toast.success(v ? "Kill-switch ENGAGED. Bot halted." : "Kill-switch disarmed.");
          } catch {
            toast.error("Couldn't toggle kill-switch.");
          }
        }}
      />

      <MetricDrilldowns
        open={drilldown}
        onOpenChange={setDrilldown}
        account={account ?? null}
        system={system ?? null}
        open_={open}
        closed={closed}
        closedToday={closedToday}
        realizedToday={realizedToday}
        unrealizedToday={unrealizedToday}
        dailyPnl={dailyPnl}
        dailyPnlPct={dailyPnlPct}
        lossToday={lossToday}
        lossVsCap={lossVsCap}
        floorDistance={floorDistance}
        pendingSignals={pendingSignals}
      />

    </div>
  );
}

function PosCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm tabular text-foreground">{value}</div>
    </div>
  );
}
