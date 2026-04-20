import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Trade, TradeSide, TradeStatus, TradeOutcome } from "@/lib/domain-types";

function mapRow(r: any): Trade {
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side as TradeSide,
    size: Number(r.size),
    entryPrice: Number(r.entry_price),
    exitPrice: r.exit_price !== null ? Number(r.exit_price) : null,
    stopLoss: r.stop_loss !== null ? Number(r.stop_loss) : null,
    takeProfit: r.take_profit !== null ? Number(r.take_profit) : null,
    currentPrice: r.current_price !== null ? Number(r.current_price) : null,
    pnl: r.pnl !== null ? Number(r.pnl) : null,
    pnlPct: r.pnl_pct !== null ? Number(r.pnl_pct) : null,
    unrealizedPnl: r.unrealized_pnl !== null ? Number(r.unrealized_pnl) : null,
    unrealizedPnlPct: r.unrealized_pnl_pct !== null ? Number(r.unrealized_pnl_pct) : null,
    status: r.status as TradeStatus,
    outcome: r.outcome as TradeOutcome | null,
    reasonTags: r.reason_tags ?? [],
    strategyVersion: r.strategy_version ?? "",
    notes: r.notes,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
  };
}

export interface NewTradeInput {
  symbol: string;
  side: TradeSide;
  size: number;
  entryPrice: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  strategyVersion?: string;
  notes?: string | null;
  reasonTags?: string[];
}

export interface CloseTradeInput {
  exitPrice: number;
  reasonTags?: string[];
  notes?: string | null;
}

export function useTrades() {
  const { user } = useAuth();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = async () => {
    if (!user) return;
    const { data, error: err } = await supabase
      .from("trades")
      .select("*")
      .eq("user_id", user.id)
      .order("opened_at", { ascending: false });
    if (err) setError(err.message);
    else setTrades((data ?? []).map(mapRow));
    setLoading(false);
  };

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    refetch();
    const channel = supabase
      .channel(`trades:${user.id}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trades", filter: `user_id=eq.${user.id}` },
        () => refetch(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const create = async (input: NewTradeInput) => {
    if (!user) throw new Error("Not signed in");
    const { error: err } = await supabase.from("trades").insert({
      user_id: user.id,
      symbol: input.symbol,
      side: input.side,
      size: input.size,
      entry_price: input.entryPrice,
      stop_loss: input.stopLoss ?? null,
      take_profit: input.takeProfit ?? null,
      strategy_version: input.strategyVersion ?? "",
      notes: input.notes ?? null,
      reason_tags: input.reasonTags ?? [],
      status: "open",
      outcome: "open",
    });
    if (err) throw err;
  };

  const close = async (id: string, input: CloseTradeInput) => {
    if (!user) throw new Error("Not signed in");
    const trade = trades.find((t) => t.id === id);
    if (!trade) throw new Error("Trade not found");
    const sideMult = trade.side === "long" ? 1 : -1;
    const pnl = (input.exitPrice - trade.entryPrice) * trade.size * sideMult;
    const pnlPct = ((input.exitPrice - trade.entryPrice) / trade.entryPrice) * 100 * sideMult;
    const outcome: TradeOutcome = pnl > 0.0001 ? "win" : pnl < -0.0001 ? "loss" : "breakeven";
    const { error: err } = await supabase
      .from("trades")
      .update({
        status: "closed",
        exit_price: input.exitPrice,
        pnl,
        pnl_pct: pnlPct,
        outcome,
        closed_at: new Date().toISOString(),
        reason_tags: input.reasonTags ?? trade.reasonTags,
        notes: input.notes ?? trade.notes,
      })
      .eq("id", id)
      .eq("user_id", user.id);
    if (err) throw err;

    // Drop a journal entry for the close
    await supabase.from("journal_entries").insert({
      user_id: user.id,
      kind: "trade",
      title: `Closed ${trade.side} ${trade.symbol} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
      summary: `Exited at $${input.exitPrice.toFixed(2)}. PnL ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}.`,
      tags: [outcome, trade.strategyVersion].filter(Boolean),
    });

    // Update account equity
    const { data: acct } = await supabase.from("account_state").select("equity, cash").eq("user_id", user.id).maybeSingle();
    if (acct) {
      await supabase
        .from("account_state")
        .update({ equity: Number(acct.equity) + pnl, cash: Number(acct.cash) + pnl })
        .eq("user_id", user.id);
    }
  };

  const remove = async (id: string) => {
    if (!user) return;
    const { error: err } = await supabase.from("trades").delete().eq("id", id).eq("user_id", user.id);
    if (err) throw err;
  };

  const open = trades.filter((t) => t.status === "open");
  const closed = trades.filter((t) => t.status === "closed");

  return { trades, open, closed, loading, error, create, close, remove, refetch };
}
