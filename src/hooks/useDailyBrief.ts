import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export type SessionBias = "risk_on" | "risk_off" | "neutral" | "caution";

export interface DailyBrief {
  id: string;
  briefDate: string; // YYYY-MM-DD (UTC)
  briefText: string;
  sessionBias: SessionBias;
  keyLevels: Record<string, { support: number | null; resistance: number | null }>;
  watchSymbols: string[];
  cautionFlags: string[];
  aiModel: string;
  updatedAt: string;
}

function mapRow(r: Record<string, unknown>): DailyBrief {
  return {
    id: String(r.id),
    briefDate: String(r.brief_date),
    briefText: String(r.brief_text ?? ""),
    sessionBias: (String(r.session_bias ?? "neutral") as SessionBias),
    keyLevels: (r.key_levels as DailyBrief["keyLevels"]) ?? {},
    watchSymbols: Array.isArray(r.watch_symbols) ? (r.watch_symbols as string[]) : [],
    cautionFlags: Array.isArray(r.caution_flags) ? (r.caution_flags as string[]) : [],
    aiModel: String(r.ai_model ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function useDailyBrief() {
  const { user } = useAuth();
  const [brief, setBrief] = useState<DailyBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error: err } = await supabase
      .from("daily_briefs")
      .select("*")
      .eq("user_id", user.id)
      .order("brief_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!err && data) setBrief(mapRow(data as Record<string, unknown>));
    else if (err) setError(err.message);
    else setBrief(null);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Sign in first.");
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/daily-brief`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({}),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 429) throw new Error("Rate limit reached. Try again in a moment.");
        if (res.status === 402) throw new Error("AI credits depleted. Top up in Workspace usage.");
        if (res.status === 504) throw new Error("Brief timed out. Retry shortly.");
        throw new Error(json.error ?? "Brief failed");
      }
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg);
      throw e;
    } finally {
      setGenerating(false);
    }
  }, [refresh]);

  const isToday = brief?.briefDate === todayUtc();

  return { brief, loading, generating, error, refresh, generate, isToday };
}
