import { useEffect, useMemo, useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { MetricCard } from "@/components/trader/MetricCard";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { RegimeBadge } from "@/components/trader/RegimeBadge";
import { AIInsightPanel } from "@/components/trader/AIInsightPanel";
import { AlertBanner } from "@/components/trader/AlertBanner";
import { GuardrailRow } from "@/components/trader/GuardrailRow";
import { Button } from "@/components/ui/button";
import {
  Activity,
  DollarSign,
  Pause,
  Play,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
  Zap,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useAccountState } from "@/hooks/useAccountState";
import { useSystemState } from "@/hooks/useSystemState";
import { useTrades } from "@/hooks/useTrades";
import { useAlerts } from "@/hooks/useAlerts";
import { useGuardrails } from "@/hooks/useGuardrails";
import { useCandles } from "@/hooks/useCandles";
import { useSignals } from "@/hooks/useSignals";
import { computeRegime } from "@/lib/regime";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Brain } from "lucide-react";

export default function Overview() {
  const { data: account } = useAccountState();
  const { data: system, update: updateSystem } = useSystemState();
  const { open, closed } = useTrades();
  const { alerts, dismiss } = useAlerts();
  const { guardrails } = useGuardrails();
  const { candles } = useCandles();
  const { pending: pendingSignals } = useSignals();
  const [brief, setBrief] = useState<string>("");
  const [briefLoading, setBriefLoading] = useState(false);
  const activeSignal = pendingSignals[0];

  const regime = useMemo(() => computeRegime("BTC-USD", candles), [candles]);
  const lastPrice = candles[candles.length - 1]?.c ?? 0;
  const firstPrice = candles[0]?.c ?? lastPrice;
  const pctChange = firstPrice ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;

  const openPosition = open[0];
  const closedToday = closed.filter((t) => t.closedAt && new Date(t.closedAt).toDateString() === new Date().toDateString());
  const realizedToday = closedToday.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const lossToday = Math.min(0, realizedToday);

  const dailyPnl = account ? account.equity - account.startOfDayEquity : 0;
  const dailyPnlPct = account && account.startOfDayEquity ? (dailyPnl / account.startOfDayEquity) * 100 : 0;
  const floorDistance = account ? ((account.equity - account.balanceFloor) / account.equity) * 100 : 0;
  const lossVsCap = account ? (Math.abs(lossToday) / account.startOfDayEquity) * 100 : 0;

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
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't toggle bot.");
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
          <div className="text-sm font-medium text-foreground tabular">
            ${lastPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
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

      {/* Metric grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricCard
          label="Equity"
          value={account ? `$${account.equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
          icon={<DollarSign className="h-3.5 w-3.5" />}
          hint={account ? `cash $${account.cash.toFixed(0)}` : undefined}
        />
        <MetricCard
          label="Daily PnL"
          value={`${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}`}
          delta={{ value: `${dailyPnlPct >= 0 ? "+" : ""}${dailyPnlPct.toFixed(2)}%`, direction: dailyPnl >= 0 ? "up" : "down" }}
          tone={dailyPnl >= 0 ? "safe" : "blocked"}
          icon={dailyPnl >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
        />
        <MetricCard label="Trades today" value={String(closedToday.length + open.length)} hint="cap 6" />
        <MetricCard label="Loss vs cap" value={`${lossVsCap.toFixed(2)}%`} hint="cap 1.50%" tone={lossVsCap > 1 ? "caution" : "safe"} />
        <MetricCard
          label="Floor distance"
          value={account ? `${floorDistance.toFixed(1)}%` : "—"}
          hint={account ? `floor $${account.balanceFloor.toFixed(0)}` : undefined}
        />
        <MetricCard
          label="Live mode"
          value={liveGated ? "Gated" : "Armed"}
          icon={<ShieldAlert className="h-3.5 w-3.5" />}
          tone={liveGated ? "blocked" : "safe"}
          hint={liveGated ? "paper-only" : "operator-armed"}
        />
      </div>

      {/* Two-column body */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <AIInsightPanel
            title="Today's market brief"
            body={brief || (briefLoading ? "Cooking up a brief…" : "No brief yet. Tap Request brief.")}
            timestamp={brief ? "now" : undefined}
            footer={
              <Link to="/copilot" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
                Open Copilot <Zap className="h-3 w-3" />
              </Link>
            }
          />

          {openPosition && (
            <div className="panel p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Open position</span>
                  <StatusBadge tone="candidate" size="sm" dot pulse>
                    monitoring
                  </StatusBadge>
                </div>
                <Link to="/trades" className="text-xs text-primary hover:underline">
                  Open trade →
                </Link>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <PosCell label="Symbol" value={openPosition.symbol} />
                <PosCell label="Side" value={openPosition.side.toUpperCase()} />
                <PosCell label="Entry" value={`$${openPosition.entryPrice.toFixed(2)}`} />
                <PosCell label="Stop" value={openPosition.stopLoss !== null ? `$${openPosition.stopLoss.toFixed(2)}` : "—"} />
                <PosCell label="TP" value={openPosition.takeProfit !== null ? `$${openPosition.takeProfit.toFixed(2)}` : "—"} />
              </div>
            </div>
          )}

          <div className="panel p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Recent alerts</span>
              <span className="text-xs text-muted-foreground">{alerts.length}</span>
            </div>
            {alerts.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No alerts. Quiet is good.</p>
            ) : (
              <div className="space-y-2">
                {alerts.slice(0, 4).map((a) => (
                  <div key={a.id} className="relative group">
                    <AlertBanner
                      severity={a.severity}
                      title={a.title}
                      message={a.message}
                      timestamp={new Date(a.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    />
                    <button
                      onClick={() => dismiss(a.id)}
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-secondary"
                      aria-label="Dismiss"
                    >
                      <X className="h-3 w-3 text-muted-foreground" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="panel p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Kill-switches</span>
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
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Quick actions</span>
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
