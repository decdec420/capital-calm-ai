import { SectionHeader } from "@/components/trader/SectionHeader";
import { MetricCard } from "@/components/trader/MetricCard";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { RegimeBadge } from "@/components/trader/RegimeBadge";
import { AIInsightPanel } from "@/components/trader/AIInsightPanel";
import { AlertBanner } from "@/components/trader/AlertBanner";
import { GuardrailRow } from "@/components/trader/GuardrailRow";
import { Button } from "@/components/ui/button";
import { Activity, DollarSign, Pause, ShieldAlert, Sparkles, TrendingDown, TrendingUp, Zap } from "lucide-react";
import { accountState, aiInsights, alerts, marketRegime, openPosition, riskGuardrails, systemState } from "@/mocks/data";
import { Link } from "react-router-dom";

export default function Overview() {
  const dailyPnl = accountState.equity - accountState.startOfDayEquity;
  const dailyPnlPct = (dailyPnl / accountState.startOfDayEquity) * 100;
  const floorDistance = ((accountState.equity - accountState.balanceFloor) / accountState.equity) * 100;

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Mission Control"
        title="Overview"
        description="Calm, decisive view of the bot, the market, and your guardrails."
        actions={
          <>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Pause className="h-3.5 w-3.5" /> Pause bot
            </Button>
            <Button size="sm" className="gap-1.5">
              <Sparkles className="h-3.5 w-3.5" /> Request brief
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
            <div className="text-base font-semibold text-foreground capitalize">{systemState.mode}</div>
          </div>
        </div>
        <div className="h-10 w-px bg-border hidden md:block" />
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Market regime</div>
          <div className="mt-1">
            <RegimeBadge regime={marketRegime.regime} confidence={marketRegime.confidence} />
          </div>
        </div>
        <div className="h-10 w-px bg-border hidden md:block" />
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Risk posture</div>
          <div className="mt-1">
            <StatusBadge tone="safe" dot>
              capital protected
            </StatusBadge>
          </div>
        </div>
        <div className="flex-1" />
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Strategy</div>
          <div className="text-sm font-medium text-foreground">trend-rev v1.3</div>
          <div className="text-[11px] text-status-candidate">candidate v1.4 paper</div>
        </div>
      </div>

      {/* Metric grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricCard
          label="Equity"
          value={`$${accountState.equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          icon={<DollarSign className="h-3.5 w-3.5" />}
          hint={`cash $${accountState.cash.toFixed(0)}`}
        />
        <MetricCard
          label="Daily PnL"
          value={`${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}`}
          delta={{ value: `${dailyPnlPct >= 0 ? "+" : ""}${dailyPnlPct.toFixed(2)}%`, direction: dailyPnl >= 0 ? "up" : "down" }}
          tone={dailyPnl >= 0 ? "safe" : "blocked"}
          icon={dailyPnl >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
        />
        <MetricCard label="Trades today" value="3" hint="cap 6" />
        <MetricCard label="Loss vs cap" value="0.27%" hint="cap 1.50%" tone="safe" />
        <MetricCard label="Floor distance" value={`${floorDistance.toFixed(1)}%`} hint={`floor $${accountState.balanceFloor.toFixed(0)}`} />
        <MetricCard
          label="Live mode"
          value="Gated"
          icon={<ShieldAlert className="h-3.5 w-3.5" />}
          tone="blocked"
          hint="paper-only"
        />
      </div>

      {/* Two-column body */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <AIInsightPanel
            title={aiInsights[0].title}
            body={aiInsights[0].body}
            timestamp="12m"
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
                <PosCell label="Stop" value={`$${openPosition.stopLoss.toFixed(2)}`} />
                <PosCell label="TP" value={`$${openPosition.takeProfit.toFixed(2)}`} />
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-border">
                <span className="text-xs text-muted-foreground">Unrealized</span>
                <span className={`text-sm tabular font-medium ${openPosition.unrealizedPnl >= 0 ? "text-status-safe" : "text-status-blocked"}`}>
                  {openPosition.unrealizedPnl >= 0 ? "+" : ""}${openPosition.unrealizedPnl.toFixed(2)} ({openPosition.unrealizedPnlPct.toFixed(2)}%)
                </span>
              </div>
            </div>
          )}

          <div className="panel p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Recent alerts</span>
              <span className="text-xs text-muted-foreground">{alerts.length}</span>
            </div>
            <div className="space-y-2">
              {alerts.map((a) => (
                <AlertBanner key={a.id} severity={a.severity} title={a.title} message={a.message} timestamp={new Date(a.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="panel p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Kill-switches</span>
              <StatusBadge tone="safe" size="sm" dot>
                armed
              </StatusBadge>
            </div>
            {riskGuardrails.slice(-3).map((g) => (
              <GuardrailRow key={g.id} guardrail={g} className="!p-3" />
            ))}
            <Link to="/risk" className="block text-xs text-primary hover:underline pt-1">
              View all guardrails →
            </Link>
          </div>

          <div className="panel p-4 space-y-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Quick actions</span>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm">Force flat</Button>
              <Button variant="outline" size="sm">Snapshot</Button>
              <Button variant="outline" size="sm">Daily report</Button>
              <Button variant="outline" size="sm" className="text-status-blocked border-status-blocked/40 hover:bg-status-blocked/10 hover:text-status-blocked">
                Halt bot
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
