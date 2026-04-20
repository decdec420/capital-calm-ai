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
        let realizedFromTp1 = 0;
        const updates: PromiseLike<unknown>[] = [];

        for (const t of open) {
          const px = priceMap.get(t.symbol);
          if (px == null) continue;
          const sideMult = t.side === "long" ? 1 : -1;

          // ---- TP1 LADDER: if price has reached tp1 and we haven't filled it,
          // close half of the ORIGINAL size at the tp1 price, lock in realized
          // PnL, halve the open size, move stop to breakeven (entry), and mark
          // tp1_filled=true. The runner stays open until take_profit or stop.
          const tp1Reached =
            !t.tp1Filled &&
            t.tp1Price != null &&
            ((t.side === "long" && px >= t.tp1Price) || (t.side === "short" && px <= t.tp1Price));

          if (tp1Reached) {
            const fullSize = t.originalSize ?? t.size;
            const halfSize = fullSize / 2;
            const realizedHalf =
              (t.tp1Price! - t.entryPrice) * halfSize * sideMult;
            realizedFromTp1 += realizedHalf;

            updates.push(
              supabase
                .from("trades")
                .update({
                  size: fullSize - halfSize,
                  tp1_filled: true,
                  stop_loss: t.entryPrice, // breakeven runner
                  pnl: (t.pnl ?? 0) + realizedHalf, // accumulated realized
                  current_price: px,
                  unrealized_pnl: (px - t.entryPrice) * (fullSize - halfSize) * sideMult,
                  unrealized_pnl_pct: ((px - t.entryPrice) / t.entryPrice) * 100 * sideMult,
                  notes: `${t.notes ?? ""}\nTP1 hit @ $${t.tp1Price!.toFixed(2)} → +$${realizedHalf.toFixed(2)} booked, runner active, stop→BE.`.trim(),
                })
                .eq("id", t.id)
                .eq("user_id", user.id),
            );

            // Journal the half-out
            updates.push(
              supabase.from("journal_entries").insert({
                user_id: user.id,
                kind: "trade",
                title: `TP1 hit · ${t.symbol} +$${realizedHalf.toFixed(2)}`,
                summary: `Booked half at $${t.tp1Price!.toFixed(2)}. Runner half stays open with stop at breakeven ($${t.entryPrice.toFixed(2)}). This is the compound machine working.`,
                tags: ["tp1", "ladder", t.symbol, t.strategyVersion].filter(Boolean),
              }),
            );

            // Bank the realized half into cash
            updates.push(
              supabase
                .from("account_state")
                .update({ cash: Number(account.cash) + realizedFromTp1 })
                .eq("user_id", user.id),
            );

            // Continue — the runner's unrealized is already written above.
            totalUnrealized += (px - t.entryPrice) * (fullSize - halfSize) * sideMult;
            continue;
          }

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

        // Roll equity. cash floats with realized TP1 fills; unrealized rides on top.
        const newCash = Number(account.cash) + realizedFromTp1;
        const newEquity = newCash + totalUnrealized;
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
