// ============================================================
// trade-close — server-authoritative manual close
// ------------------------------------------------------------
// The browser used to update trades.status/exit_price/pnl directly
// from useTrades.close(). That's now blocked by the Phase 2
// trigger. This edge function is the only path an operator can
// take to manually close an open trade. It:
//
//   1. Validates JWT, fetches the trade.
//   2. Fetches the current Coinbase ticker for a live exit fill.
//   3. Runs the same P&L math the mark-to-market loop uses so the
//      result is consistent across both paths.
//   4. Transitions lifecycle via transitionTrade().
//   5. Writes a journal entry.
//   6. Updates account_state.cash and recomputes equity.
// ============================================================

import { fetchTicker } from "../_shared/market.ts";
import { isWhitelistedSymbol, validateDoctrineInvariants } from "../_shared/doctrine.ts";
import {
  getBrokerCredentials,
  placeMarketSell,
} from "../_shared/broker.ts";
import { effectivePnl, recordFill } from "../_shared/fills.ts";
import {
  appendTransition,
  transitionTrade,
  type LifecycleTransition,
  type TradeLifecyclePhase,
} from "../_shared/lifecycle.ts";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import { corsHeaders, makeCorsHeaders} from "../_shared/cors.ts";

validateDoctrineInvariants();


Deno.serve(async (req) => {
    const cors = makeCorsHeaders(req);
if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const tradeId = String(body.tradeId ?? "");
    const reason = body.reason ? String(body.reason) : "Operator closed";

    if (!tradeId) {
      return new Response(JSON.stringify({ error: "tradeId required" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const { createClient } = await import(
      "https://esm.sh/@supabase/supabase-js@2.45.0"
    );
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Rate limit: 20 req / 60s per user
    const rl = await checkRateLimit(admin, userId, "trade-close", 20);
    if (!rl.allowed) return rateLimitResponse(rl, cors);

    const { data: trade, error: tradeErr } = await admin
      .from("trades")
      .select(
        "id,user_id,symbol,side,size,original_size,entry_price,stop_loss,take_profit,tp1_price,tp1_filled,pnl,lifecycle_phase,lifecycle_transitions,status,strategy_version,notes",
      )
      .eq("id", tradeId)
      .eq("user_id", userId)
      .maybeSingle();

    if (tradeErr || !trade) {
      return new Response(JSON.stringify({ error: "Trade not found" }), {
        status: 404,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (trade.status !== "open") {
      return new Response(
        JSON.stringify({ error: `Trade already ${trade.status}` }),
        {
          status: 409,
          headers: { ...cors, "Content-Type": "application/json" },
        },
      );
    }

    if (!isWhitelistedSymbol(trade.symbol)) {
      return new Response(
        JSON.stringify({ error: `Symbol ${trade.symbol} not on whitelist` }),
        {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        },
      );
    }

    // ── Check live mode ───────────────────────────────────────────────
    const { data: sysRow } = await admin
      .from("system_state")
      .select("live_trading_enabled")
      .eq("user_id", userId)
      .maybeSingle();
    const liveEnabled = !!sysRow?.live_trading_enabled;

    // Fill price — either from real broker (live) or Coinbase spot ticker (paper).
    // LIVE: place SELL order first. Fail-safe: if broker throws, return 502 and
    // write nothing to DB. The position stays open in both the broker and DB.
    let fillPx: number;
    let brokerOrderId: string | null = null;
    let exitFeesUsd = 0;
    // deno-lint-ignore no-explicit-any
    let liveFill: any = null;

    if (liveEnabled) {
      try {
        const creds = await getBrokerCredentials(admin);
        const remainingForSell = Number(trade.size);
        // Deterministic close clientOrderId — retries hit Coinbase's idempotency
        // and never double-sell a position.
        const closeClientOrderId = `${trade.id}-close`;
        const fill = await placeMarketSell(
          creds,
          trade.symbol,
          remainingForSell.toFixed(8),
          closeClientOrderId,
        );
        fillPx = fill.fillPrice;
        brokerOrderId = fill.orderId;
        exitFeesUsd = Number.isFinite(fill.feesUsd) ? fill.feesUsd : 0;
        liveFill = fill;
        console.log(
          `[trade-close] LIVE SELL filled: ${trade.symbol} @ $${fillPx} ` +
            `size=${remainingForSell} orderId=${brokerOrderId} fees=$${exitFeesUsd.toFixed(4)}`,
        );
      } catch (brokerErr) {
        const msg = brokerErr instanceof Error ? brokerErr.message : String(brokerErr);
        console.error("[trade-close] Broker order failed:", msg);
        return new Response(
          JSON.stringify({
            error: "Broker SELL failed — trade NOT closed. Check Coinbase dashboard.",
            code: "BROKER_ORDER_FAILED",
            detail: msg,
          }),
          {
            status: 502,
            headers: { ...cors, "Content-Type": "application/json" },
          },
        );
      }
    } else {
      // Paper mode: use Coinbase spot price as the fill price.
      const ticker = await fetchTicker(trade.symbol);
      fillPx = Number(ticker.price);
      if (!Number.isFinite(fillPx) || fillPx <= 0) {
        return new Response(
          JSON.stringify({ error: "Could not fetch live price" }),
          {
            status: 502,
            headers: { ...cors, "Content-Type": "application/json" },
          },
        );
      }
    }

    // Persist the fill before touching the trade row so the cost ledger
    // is correct even if the trade UPDATE later fails.
    if (liveFill) {
      await recordFill(admin, {
        userId,
        tradeId: trade.id,
        symbol: trade.symbol,
        fillKind: "manual_close",
        proposedPrice: fillPx, // no specific target on a manual close
        fill: liveFill,
      });
    }

    const sideMult = trade.side === "long" ? 1 : -1;
    const remainingSize = Number(trade.size);
    const entry = Number(trade.entry_price);
    const realizedRemainder = (fillPx - entry) * remainingSize * sideMult;
    const cumulativePnl = Number(trade.pnl ?? 0) + realizedRemainder;
    const pnlPct = ((fillPx - entry) / entry) * 100 * sideMult;
    const outcome = cumulativePnl >= 0 ? "win" : "loss";

    // Lifecycle: current → exited via FSM.
    const fromPhase: TradeLifecyclePhase =
      (trade.lifecycle_phase as TradeLifecyclePhase | null) ??
      (trade.tp1_filled ? "tp1_hit" : "entered");
    const fsm = transitionTrade(fromPhase, "exited", {
      actor: "user",
      reason,
      meta: { fillPrice: fillPx, outcome },
    });
    if (!fsm.ok) {
      return new Response(
        JSON.stringify({ error: fsm.error ?? "Illegal transition" }),
        {
          status: 409,
          headers: { ...cors, "Content-Type": "application/json" },
        },
      );
    }
    const transition: LifecycleTransition = fsm.transition!;
    const nextTransitions = appendTransition(
      trade.lifecycle_transitions,
      transition,
    );

    const nowIso = new Date().toISOString();

    await admin
      .from("trades")
      .update({
        status: "closed",
        size: 0,
        current_price: fillPx,
        unrealized_pnl: 0,
        unrealized_pnl_pct: 0,
        exit_price: fillPx,
        pnl: cumulativePnl,
        pnl_pct: pnlPct,
        closed_at: nowIso,
        outcome,
        lifecycle_phase: "exited",
        lifecycle_transitions: nextTransitions,
        notes: `${trade.notes ?? ""}\n${liveEnabled ? "LIVE " : ""}Closed @ $${fillPx.toFixed(2)} · ${reason} · realized $${realizedRemainder.toFixed(2)} · total $${cumulativePnl.toFixed(2)}${brokerOrderId ? ` · Coinbase orderId: ${brokerOrderId}` : ""}`
          .trim(),
        ...(brokerOrderId ? { broker_close_order_id: brokerOrderId } : {}),
      })
      .eq("id", trade.id);

    await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "trade",
      title: `Closed ${trade.side.toUpperCase()} ${trade.symbol} ${cumulativePnl >= 0 ? "+" : ""}$${cumulativePnl.toFixed(2)}`,
      summary: reason,
      tags: [
        "manual-close",
        trade.symbol,
        trade.strategy_version ?? "v2",
        outcome,
      ].filter(Boolean),
    });

    // Bank realized remainder to cash and roll equity (≡ cash when no open pos).
    const { data: acct } = await admin
      .from("account_state")
      .select("cash,equity")
      .eq("user_id", userId)
      .maybeSingle();
    if (acct) {
      const newCash = Number(acct.cash ?? 0) + realizedRemainder;
      // Any remaining unrealized from other open trades still rides; the
      // next mark-to-market tick recomputes that. For safety we leave
      // equity alone here and let the mark-to-market loop normalize.
      await admin
        .from("account_state")
        .update({ cash: newCash })
        .eq("user_id", userId);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        tradeId: trade.id,
        fillPrice: fillPx,
        pnl: cumulativePnl,
        outcome,
      }),
      {
        headers: { ...cors, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error("trade-close error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }),
      {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      },
    );
  }
});
