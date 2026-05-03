import { useMemo, useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { MetricCard } from "@/components/trader/MetricCard";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { RegimeBadge } from "@/components/trader/RegimeBadge";
import { DailyBriefPanel } from "@/components/trader/DailyBriefPanel";
import { DoctrineProposalBanner } from "@/components/trader/DoctrineProposalBanner";
import { SymbolStrip } from "@/components/trader/SymbolStrip";

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
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useAccountState } from "@/hooks/useAccountState";
import { useSystemState } from "@/hooks/useSystemState";
import { useTrades } from "@/hooks/useTrades";

import { useGuardrails } from "@/hooks/useGuardrails";
import { useCandles } from "@/hooks/useCandles";
import { useSignals } from "@/hooks/useSignals";
import { computeRegime } from "@/lib/regime";

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
  const { open, closed } = useTrades();
  
  const { guardrails } = useGuardrails();
  const { candles } = useCandles();
  const { pending: pendingSignals } = useSignals();
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
  
  // (Per-symbol prices are now rendered by SymbolStrip from the snapshot.)

  const openPosition = open[0];
  const closedToday = closed.filter((t) => t.closedAt && new Date(t.closedAt).toDateString() === new Date().toDateString());
  const realizedToday = closedToday.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const unrealizedToday = open.reduce((sum, t) => sum + (t.unrealizedPnl ?? 0), 0);
  const lossToday = Math.min(0, realizedToday);


  

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
          <Button variant="outline" size="sm" className="gap-1.5" onClick={toggleBot}>
            {system?.bot === "running" ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {system?.bot === "running" ? "Pause bot" : "Resume bot"}
          </Button>
        }
      />

      {system && (
        <BrokerStatusInline
          connection={system.brokerConnection}
          liveArmed={system.liveTradingEnabled}
        />
      )}

      {/* Trading pause — shown inline in DailyBriefPanel above */}

      {/* Compact status row */}
      <div className="panel p-4 flex flex-wrap items-center gap-x-6 gap-y-3 bg-gradient-surface">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-md bg-primary/15 text-primary flex items-center justify-center">
            <Activity className="h-4 w-4" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">System mode</div>
            <div className="text-sm font-semibold text-foreground capitalize">{system?.mode ?? "—"}</div>
          </div>
        </div>
        <div className="h-9 w-px bg-border hidden md:block" />
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">BTC regime</div>
          <div className="mt-0.5">
            <RegimeBadge regime={regime.regime} confidence={regime.confidence} />
          </div>
        </div>
        <div className="h-9 w-px bg-border hidden md:block" />
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Risk posture</div>
          <div className="mt-0.5">
            <StatusBadge tone={floorDistance > 2 ? "safe" : "caution"} dot>
              {floorDistance > 2 ? "capital protected" : "near floor"}
            </StatusBadge>
          </div>
        </div>
      </div>

      {/* Per-symbol price + regime strip */}
      <SymbolStrip
        perSymbol={snapshot?.perSymbol ?? []}
        ranAt={snapshot?.ranAt ?? null}
      />

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

          {/* Tactical reads & strategy roster live on dedicated tabs to keep
              Overview scannable. Quick links surface the freshest context. */}
          <div className="panel p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Link
              to="/market-intel"
              className="rounded-md border border-border/60 bg-card/40 px-3 py-2.5 hover:border-primary/40 hover:bg-primary/5 transition-colors group"
            >
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Market Intel
              </div>
              <div className="text-sm text-foreground mt-0.5 group-hover:text-primary transition-colors">
                Macro · regimes · key levels →
              </div>
            </Link>
            <Link
              to="/copilot"
              className="rounded-md border border-border/60 bg-card/40 px-3 py-2.5 hover:border-primary/40 hover:bg-primary/5 transition-colors group"
            >
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Copilot
              </div>
              <div className="text-sm text-foreground mt-0.5 group-hover:text-primary transition-colors">
                Bobby's live tactical read →
              </div>
            </Link>
            <Link
              to="/edge"
              className="rounded-md border border-border/60 bg-card/40 px-3 py-2.5 hover:border-primary/40 hover:bg-primary/5 transition-colors group"
            >
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Edge
              </div>
              <div className="text-sm text-foreground mt-0.5 group-hover:text-primary transition-colors">
                Strategy roster · performance →
              </div>
            </Link>
          </div>

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
