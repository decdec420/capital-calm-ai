import { useEffect, useState } from "react";
import { useTableChanges } from "@/hooks/useRealtimeSubscriptions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type {
  TradeSignal,
  SignalStatus,
  SignalDecidedBy,
  TradeSide,
  SignalLifecyclePhase,
  LifecycleTransition,
} from "@/lib/domain-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(r: any): TradeSignal {
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side as TradeSide,
    directionBasis: (r.direction_basis ?? null) as TradeSignal["directionBasis"],
    confidence: Number(r.confidence),
    setupScore: Number(r.setup_score),
    regime: r.regime,
    proposedEntry: Number(r.proposed_entry),
    proposedStop: r.proposed_stop !== null ? Number(r.proposed_stop) : null,
    proposedTarget: r.proposed_target !== null ? Number(r.proposed_target) : null,
    sizeUsd: Number(r.size_usd),
    sizePct: Number(r.size_pct),
    aiReasoning: r.ai_reasoning ?? "",
    aiModel: r.ai_model ?? "",
    contextSnapshot: r.context_snapshot ?? {},
    status: r.status as SignalStatus,
    decidedBy: (r.decided_by ?? null) as SignalDecidedBy | null,
    decisionReason: r.decision_reason ?? null,
    executedTradeId: r.executed_trade_id ?? null,
    strategyId: r.strategy_id ?? null,
    strategyVersion: r.strategy_version ?? null,
    lifecyclePhase: (r.lifecycle_phase ?? "proposed") as SignalLifecyclePhase,
    lifecycleTransitions: Array.isArray(r.lifecycle_transitions)
      ? (r.lifecycle_transitions as LifecycleTransition[])
      : [],
    expiresAt: r.expires_at,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  };
}

export function useSignals() {
  const { user } = useAuth();
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("trade_signals")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);
    setSignals((data ?? []).map(mapRow));
    setLoading(false);
  };

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useTableChanges("trade_signals", refetch);

  const now = Date.now();
  const pending = signals.filter((s) => s.status === "pending" && new Date(s.expiresAt).getTime() > now);
  const history = signals.filter((s) => s.status !== "pending" || new Date(s.expiresAt).getTime() <= now);

  return { signals, pending, history, loading, refetch };
}
