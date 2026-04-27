// ScalingReadinessPanel — read-only checklist that tells the operator
// whether it's safe to raise the doctrine caps beyond paper-mode pennies.
// Source of truth: real `trades`, `strategies`, `system_state` rows.
// Collapsed by default — this is reference, not a CTA.

import { useEffect, useState } from "react";
import { ChevronDown, CheckCircle2, XCircle } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

interface ChecklistItem {
  pass: boolean;
  label: string;
  detail: string;
  source: string;
}

export function ScalingReadinessPanel() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);

      const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const [tradesRes, strategiesRes, sysRes, brokerRes] = await Promise.all([
        supabase.from("trades").select("pnl,closed_at,outcome").eq("user_id", user.id).eq("status", "closed"),
        supabase.from("strategies").select("id,status,created_at,parent_strategy_id").eq("user_id", user.id),
        supabase.from("system_state").select("params_wired_live,broker_connection,mode").eq("user_id", user.id).maybeSingle(),
        supabase.from("broker_credentials").select("status,mode").eq("user_id", user.id).maybeSingle(),
      ]);

      const trades = tradesRes.data ?? [];
      const strategies = strategiesRes.data ?? [];
      const sys = sysRes.data;
      const broker = brokerRes.data;

      // 1. Positive expectancy over ≥50 paper trades
      const pnls = trades.map((t: any) => Number(t.pnl ?? 0));
      const tradeCount = trades.length;
      const expR = tradeCount > 0 ? pnls.reduce((a, b) => a + b, 0) / tradeCount : 0;
      const expectancyPass = tradeCount >= 50 && expR > 0;

      // 2. Drawdown under 25% — peak-to-trough on equity curve from cumulative pnl
      let peak = 0, equity = 0, maxDD = 0;
      const sorted = [...trades].sort((a: any, b: any) =>
        new Date(a.closed_at ?? 0).getTime() - new Date(b.closed_at ?? 0).getTime()
      );
      for (const t of sorted) {
        equity += Number((t as any).pnl ?? 0);
        if (equity > peak) peak = equity;
        if (peak > 0) {
          const dd = (peak - equity) / peak;
          if (dd > maxDD) maxDD = dd;
        }
      }
      const ddPct = maxDD * 100;
      const ddPass = tradeCount === 0 ? false : ddPct < 25;

      // 3. Net profitable last 30 days
      const recent = trades.filter((t: any) => t.closed_at && t.closed_at >= since30d);
      const netRecent = recent.reduce((s: number, t: any) => s + Number(t.pnl ?? 0), 0);
      const netPass = netRecent > 0;

      // 4. At least one full learning cycle — a non-seed strategy that
      // descended from a parent and is currently approved/archived means
      // a cycle completed.
      const cycleDone = strategies.some(
        (s: any) => s.parent_strategy_id && (s.status === "approved" || s.status === "archived")
      );

      // 5. Strategy params wired into live engine
      const paramsWired = !!sys?.params_wired_live;

      // 6. Real broker connected (not paper)
      const brokerLive =
        !!broker &&
        broker.status === "connected" &&
        broker.mode === "live" &&
        sys?.broker_connection === "connected";

      const next: ChecklistItem[] = [
        {
          pass: expectancyPass,
          label: "Positive expectancy over ≥50 paper trades",
          detail: `${tradeCount} trades · ${expR >= 0 ? "+" : ""}$${expR.toFixed(2)} avg`,
          source: "All your closed paper trades, across every strategy.",
        },
        {
          pass: ddPass,
          label: "Max drawdown under 25% on real paper trades",
          detail: tradeCount === 0 ? "no trades yet" : `${ddPct.toFixed(1)}%`,
          source: "Peak-to-trough on the cumulative paper-trade equity curve.",
        },
        {
          pass: netPass,
          label: "Net profitable over last 30 days",
          detail: `${netRecent >= 0 ? "+" : ""}$${netRecent.toFixed(2)}`,
          source: "Sum of paper-trade pnl over the trailing 30 days.",
        },
        {
          pass: cycleDone,
          label: "At least one full learning cycle completed",
          detail: cycleDone ? "propose → backtest → promote → paper" : "no promoted descendant strategy yet",
          source: "Any strategy descended from another that ended up approved or archived.",
        },
        {
          pass: paramsWired,
          label: "Strategy params wired into live engine",
          detail: paramsWired ? "engine reads strategy params" : "engine using hardcoded defaults",
          source: "system_state.params_wired_live",
        },
        {
          pass: brokerLive,
          label: "Broker connected (real, not paper)",
          detail: brokerLive ? "live broker linked" : "paper mode — no real broker",
          source: "broker_credentials + system_state.broker_connection",
        },
      ];

      if (!cancelled) {
        setItems(next);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  const passing = items.filter((i) => i.pass).length;
  const total = items.length;
  const allGreen = total > 0 && passing === total;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="panel">
        <CollapsibleTrigger asChild>
          <button className="w-full px-4 py-3 border-b border-border flex items-center justify-between hover:bg-accent/30 transition-colors">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-foreground font-semibold">
                🔒 Scaling readiness
              </span>
              <StatusBadge tone={allGreen ? "safe" : "neutral"} size="sm">
                {passing}/{total}
              </StatusBadge>
            </div>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-4 py-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              All of these must be green before raising doctrine caps beyond $1/trade.
            </p>
            {loading ? (
              <p className="text-xs text-muted-foreground italic">Loading…</p>
            ) : (
              <ul className="space-y-2">
                {items.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-3 text-xs">
                    {item.pass ? (
                      <CheckCircle2 className="h-4 w-4 text-status-safe shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    )}
                    <div className="flex-1">
                      <div className={cn("font-medium", item.pass ? "text-foreground" : "text-muted-foreground")}>
                        {item.label}
                      </div>
                      <div className="text-[11px] text-muted-foreground tabular">{item.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="text-[11px] text-muted-foreground border-t border-border pt-3">
              When all green: edit <code className="font-mono text-foreground">doctrine.ts</code> to raise{" "}
              <code className="font-mono text-foreground">maxOrderUsdHardCap</code>. Do it deliberately.
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
