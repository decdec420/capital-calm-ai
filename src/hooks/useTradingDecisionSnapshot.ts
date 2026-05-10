import { useMemo } from "react";
import { useSystemState } from "@/hooks/useSystemState";
import { useMarketIntelligence } from "@/hooks/useMarketIntelligence";
import { useStrategies } from "@/hooks/useStrategies";
import { useAlerts } from "@/hooks/useAlerts";
import {
  computeTradingDecisionSnapshot,
  type TradingDecisionSnapshot,
} from "@/lib/trading-decision-snapshot";

/**
 * Computes the canonical TradingDecisionSnapshot from existing hooks.
 * Does not add new DB queries — composed entirely from already-fetched data.
 */
export function useTradingDecisionSnapshot(): {
  snapshot: TradingDecisionSnapshot | null;
  loading: boolean;
} {
  const { data: system, loading: sysLoading } = useSystemState();
  const { data: marketIntelligence, loading: miLoading } = useMarketIntelligence();
  const { strategies, loading: stratLoading } = useStrategies();
  const { alerts, loading: alertsLoading } = useAlerts();

  const loading = sysLoading || miLoading || stratLoading || alertsLoading;

  const snapshot = useMemo(() => {
    if (loading && !system) return null;
    return computeTradingDecisionSnapshot({
      system: system ?? null,
      marketIntelligence: marketIntelligence ?? [],
      strategies: strategies ?? [],
      alerts: alerts ?? [],
    });
  }, [system, marketIntelligence, strategies, alerts, loading]);

  return { snapshot, loading };
}
