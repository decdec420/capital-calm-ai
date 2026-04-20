import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useTrades } from "@/hooks/useTrades";
import { useAccountState } from "@/hooks/useAccountState";

// Polls Coinbase spot for every distinct symbol that has an open trade,
// then writes current_price + unrealized_pnl + unrealized_pnl_pct on each
// open trade row, and rolls equity = cash + Σ unrealized_pnl on account_state.
// This keeps Overview, footer, and every page in sync with live market price
// whether the trade was logged manually or auto-fired by the signal engine.
export function useMarkToMarket(intervalMs = 30_000) {
  const { user } = useAuth();
  const { open } = useTrades();
  const { data: account } = useAccountState();
  const inFlight = useRef(false);

  useEffect(() => {
    if (!user || open.length === 0 || !account) return;

    const symbols = Array.from(new Set(open.map((t) => t.symbol)));

    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        // Fetch spot prices in parallel
        const priceEntries = await Promise.all(
          symbols.map(async (sym) => {
            try {
              const res = await fetch(`https://api.exchange.coinbase.com/products/${sym}/ticker`);
              if (!res.ok) return [sym, null] as const;
              const j = await res.json();
              const px = Number(j?.price);
              return [sym, Number.isFinite(px) ? px : null] as const;
            } catch {
              return [sym, null] as const;
            }
          }),
        );
        const priceMap = new Map(priceEntries);

        let totalUnrealized = 0;
        const updates: Promise<unknown>[] = [];

        for (const t of open) {
          const px = priceMap.get(t.symbol);
          if (px == null) continue;
          const sideMult = t.side === "long" ? 1 : -1;
          const upnl = (px - t.entryPrice) * t.size * sideMult;
          const upnlPct = ((px - t.entryPrice) / t.entryPrice) * 100 * sideMult;
          totalUnrealized += upnl;

          // Only write if something actually changed enough to matter (1 cent)
          const prev = t.currentPrice ?? 0;
          if (Math.abs(prev - px) < 0.01 && t.unrealizedPnl !== null) continue;

          updates.push(
            supabase
              .from("trades")
              .update({
                current_price: px,
                unrealized_pnl: upnl,
                unrealized_pnl_pct: upnlPct,
              })
              .eq("id", t.id)
              .eq("user_id", user.id),
          );
        }

        // Roll equity. cash stays put — paper accounting treats cash as
        // "what's left if every position closed at entry". Equity floats with PnL.
        const newEquity = Number(account.cash) + totalUnrealized;
        if (Math.abs(newEquity - account.equity) > 0.01) {
          updates.push(
            supabase
              .from("account_state")
              .update({ equity: newEquity })
              .eq("user_id", user.id),
          );
        }

        await Promise.all(updates);
      } finally {
        inFlight.current = false;
      }
    };

    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, open.map((t) => t.id + t.symbol).join("|"), account?.cash, intervalMs]);
}
