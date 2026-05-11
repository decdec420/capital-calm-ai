import { useMemo } from "react";
import { useSystemState } from "@/hooks/useSystemState";
import { useMarketIntelligence } from "@/hooks/useMarketIntelligence";
import { useStrategies } from "@/hooks/useStrategies";
import { useAlerts } from "@/hooks/useAlerts";
import { useTrades } from "@/hooks/useTrades";
import { useAccountState } from "@/hooks/useAccountState";
import {
  computeTradingDecisionSnapshot,
  type TradingDecisionSnapshot,
} from "@/lib/trading-decision-snapshot";

/**
 * Computes the canonical TradingDecisionSnapshot from existing hooks.
 * Includes portfolio-level risk from open trades + account state.
 */
export function useTradingDecisionSnapshot(): {
  snapshot: TradingDecisionSnapshot | null;
  loading: boolean;
} {
  const { data: system, loading: sysLoading } = useSystemState();
  const { data: marketIntelligence, loading: miLoading } = useMarketIntelligence();
  const { strategies, loading: stratLoading } = useStrategies();
  const { alerts, loading: alertsLoading } = useAlerts();
  const { open: openTrades, loading: tradesLoading } = useTrades();
  const { data: account, loading: accountLoading } = useAccountState();

  const loading =
    sysLoading || miLoading || stratLoading || alertsLoading || tradesLoading || accountLoading;

  const snapshot = useMemo(() => {
    if (loading && !system) return null;
    return computeTradingDecisionSnapshot({
      system: system ?? null,
      marketIntelligence: marketIntelligence ?? [],
      strategies: strategies ?? [],
      alerts: alerts ?? [],
      portfolioRiskInput: {
        openTrades: openTrades ?? [],
        account: account ?? null,
        mode: system?.mode ?? "unknown",
      },
    });
  }, [system, marketIntelligence, strategies, alerts, openTrades, account, loading]);

  return { snapshot, loading };
}
