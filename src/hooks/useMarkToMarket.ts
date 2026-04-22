import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useTrades } from "@/hooks/useTrades";

// ============================================================
// Browser mark-to-market nudge
// ------------------------------------------------------------
// As of Phase 2, the canonical mark-to-market loop runs in the
// `mark-to-market` edge function on a pg_cron every 15s. The
// browser can no longer write to trades.current_price,
// trades.unrealized_pnl, trades.size, trades.stop_loss, or
// account_state.equity directly (the Phase 2 trigger blocks it).
//
// This hook survives as a UI nudge: when a user has open trades
// and the page is visible, call the edge function every 30s so
// the operator always sees fresh numbers even if the cron is
// running slow. Realtime subscriptions on the trades table then
// push the new rows back into the UI.
// ============================================================
export function useMarkToMarket(intervalMs = 30_000) {
  const { user } = useAuth();
  const { open } = useTrades();
  const inFlight = useRef(false);

  useEffect(() => {
    if (!user || open.length === 0) return;

    const nudge = async () => {
      if (inFlight.current) return;
      if (document.visibilityState !== "visible") return;
      inFlight.current = true;
      try {
        await supabase.functions.invoke("mark-to-market", { body: {} });
      } catch (e) {
        // The cron is the source of truth; a failed nudge is not fatal.
        console.warn("mark-to-market nudge failed (harmless):", e);
      } finally {
        inFlight.current = false;
      }
    };

    nudge();
    const id = setInterval(nudge, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, open.map((t) => t.id).join("|"), intervalMs]);
}
