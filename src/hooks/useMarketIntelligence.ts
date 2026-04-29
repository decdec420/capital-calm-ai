import { useCallback, useEffect, useState } from "react";
import { useTableChanges } from "@/hooks/useRealtimeSubscriptions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface MarketIntelligence {
  id: string;
  symbol: string;
  // Macro
  macroBias: "strong_long" | "lean_long" | "neutral" | "lean_short" | "strong_short";
  macroConfidence: number;
  marketPhase: "accumulation" | "markup" | "distribution" | "markdown" | "unknown";
  trendStructure: "uptrend" | "downtrend" | "range" | "transitioning" | "unknown";
  nearestSupport: number | null;
  nearestResistance: number | null;
  keyLevelNotes: string;
  macroSummary: string;
  // Crypto
  fundingRateSignal:
    | "crowded_long"
    | "lean_long"
    | "neutral"
    | "lean_short"
    | "crowded_short";
  fundingRatePct: number | null;
  fearGreedScore: number | null;
  fearGreedLabel: string | null;
  sentimentSummary: string;
  environmentRating:
    | "highly_favorable"
    | "favorable"
    | "neutral"
    | "unfavorable"
    | "highly_unfavorable";
  // Pattern
  patternContext: string;
  entryQualityContext: string;
  // Meta
  generatedAt: string;
  candleCount1h: number | null;
  candleCount4h: number | null;
  candleCount1d: number | null;
}

function mapRow(r: Record<string, unknown>): MarketIntelligence {
  const num = (k: string): number | null => {
    const v = r[k];
    return v == null ? null : Number(v);
  };
  const str = (k: string, fallback = ""): string =>
    typeof r[k] === "string" ? (r[k] as string) : fallback;
  return {
    id: r.id as string,
    symbol: r.symbol as string,
    macroBias: str("macro_bias", "neutral") as MarketIntelligence["macroBias"],
    macroConfidence: Number(r.macro_confidence ?? 0.5),
    marketPhase: str("market_phase", "unknown") as MarketIntelligence["marketPhase"],
    trendStructure: str("trend_structure", "unknown") as MarketIntelligence["trendStructure"],
    nearestSupport: num("nearest_support"),
    nearestResistance: num("nearest_resistance"),
    keyLevelNotes: str("key_level_notes"),
    macroSummary: str("macro_summary"),
    fundingRateSignal: str(
      "funding_rate_signal",
      "neutral",
    ) as MarketIntelligence["fundingRateSignal"],
    fundingRatePct: num("funding_rate_pct"),
    fearGreedScore: num("fear_greed_score"),
    fearGreedLabel: typeof r.fear_greed_label === "string" ? (r.fear_greed_label as string) : null,
    sentimentSummary: str("sentiment_summary"),
    environmentRating: str(
      "environment_rating",
      "neutral",
    ) as MarketIntelligence["environmentRating"],
    patternContext: str("pattern_context"),
    entryQualityContext: str("entry_quality_context"),
    generatedAt: r.generated_at as string,
    candleCount1h: num("candle_count_1h"),
    candleCount4h: num("candle_count_4h"),
    candleCount1d: num("candle_count_1d"),
  };
}

/**
 * Pulls the cached market_intelligence rows for the signed-in user.
 * Cron refreshes them every 4 hours; UI can also trigger an on-demand refresh.
 */
export function useMarketIntelligence() {
  const { user } = useAuth();
  const [data, setData] = useState<MarketIntelligence[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    const { data: rows, error } = await supabase
      .from("market_intelligence")
      .select("*")
      .eq("user_id", user.id);
    if (error) {
      console.error("market_intelligence load failed", error);
      setData([]);
    } else {
      setData((rows ?? []).map(mapRow));
    }
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (!user) {
      setData([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    load();

    // Realtime refresh delegated to shared subscription manager (HIGH-6).
    useTableChanges("market_intelligence", load);
  }, [user, load]);

  /** Trigger an on-demand brain trust run for all 3 symbols. */
  const refresh = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    setRefreshing(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return { ok: false, error: "Not signed in." };

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/market-intelligence`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ source: "ui" }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: body?.error ?? `Refresh failed (${res.status}).` };
      }
      await load();
      return { ok: true };
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  return { data, loading, refreshing, refresh };
}
