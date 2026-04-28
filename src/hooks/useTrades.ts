import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type {
  Trade,
  TradeSide,
  TradeStatus,
  TradeOutcome,
  TradeLifecyclePhase,
  LifecycleTransition,
} from "@/lib/domain-types";

function mapRow(r: any): Trade {
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side as TradeSide,
    directionBasis: (r.direction_basis ?? null) as Trade["directionBasis"],
    size: Number(r.size),
    originalSize: r.original_size !== null && r.original_size !== undefined ? Number(r.original_size) : null,
    entryPrice: Number(r.entry_price),
    exitPrice: r.exit_price !== null ? Number(r.exit_price) : null,
    stopLoss: r.stop_loss !== null ? Number(r.stop_loss) : null,
    takeProfit: r.take_profit !== null ? Number(r.take_profit) : null,
    tp1Price: r.tp1_price !== null && r.tp1_price !== undefined ? Number(r.tp1_price) : null,
    tp1Filled: Boolean(r.tp1_filled),
    currentPrice: r.current_price !== null ? Number(r.current_price) : null,
    pnl: r.pnl !== null ? Number(r.pnl) : null,
    pnlPct: r.pnl_pct !== null ? Number(r.pnl_pct) : null,
    unrealizedPnl: r.unrealized_pnl !== null ? Number(r.unrealized_pnl) : null,
    unrealizedPnlPct: r.unrealized_pnl_pct !== null ? Number(r.unrealized_pnl_pct) : null,
    status: r.status as TradeStatus,
    outcome: r.outcome as TradeOutcome | null,
    reasonTags: r.reason_tags ?? [],
    strategyVersion: r.strategy_version ?? "",
    strategyId: r.strategy_id ?? null,
    lifecyclePhase: (r.lifecycle_phase ?? "entered") as TradeLifecyclePhase,
    lifecycleTransitions: Array.isArray(r.lifecycle_transitions)
      ? (r.lifecycle_transitions as LifecycleTransition[])
      : [],
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
  /**
   * Optional — ignored by the server. `trade-close` fetches the live
   * Coinbase spot price and uses that as the fill. Kept here for
   * backwards-compat with callers that still pass a price they saw
   * in the UI.
   */
  exitPrice?: number;
  /** Operator-supplied reason string (journaled). */
  reason?: string;
  /** Back-compat aliases; not forwarded anywhere meaningful. */
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

  /**
   * Close an open trade. The browser can no longer write to
   * status/exit_price/pnl/closed_at/outcome directly (Phase 2
   * trigger blocks it). This helper delegates to the `trade-close`
   * edge function which fetches the live Coinbase spot price,
   * computes realized P&L, transitions the lifecycle FSM, and
   * banks the result to account_state.cash.
   */
  const close = async (id: string, input: CloseTradeInput = {}) => {
    if (!user) throw new Error("Not signed in");
    const trade = trades.find((t) => t.id === id);
    if (!trade) throw new Error("Trade not found");

    const { data, error: err } = await supabase.functions.invoke("trade-close", {
      body: {
        tradeId: id,
        reason: input.reason ?? "Operator closed",
      },
    });
    if (err) throw err;
    if (data?.error) throw new Error(String(data.error));

    // The edge function already inserts the journal row and updates
    // account_state.cash. Realtime on the trades table will kick the
    // `refetch()` subscribed above, so the UI is self-refreshing.
    return data as {
      ok: boolean;
      tradeId: string;
      fillPrice: number;
      pnl: number;
      outcome: TradeOutcome;
    };
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
