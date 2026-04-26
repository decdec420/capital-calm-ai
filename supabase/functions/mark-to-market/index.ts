// ============================================================
// mark-to-market — server-authoritative trade monitor
// ------------------------------------------------------------
// Runs every 15 seconds (pg_cron → http_post) OR can be invoked
// with a user JWT from the browser for an on-demand refresh.
//
// Responsibilities:
//   1. Fetch latest tickers for every symbol that has an open
//      trade (globally, de-duped).
//   2. For each open trade:
//      - Update current_price / unrealized_pnl / unrealized_pnl_pct.
//      - Evaluate TP1/TP2/stop via evaluateTradeInCandle — the
//        exact same FSM the backend Trader used.
//      - On TP1 fill: close half, move stop to BE, bank realized
//        half to cash, transition lifecycle_phase → tp1_hit.
//      - On TP2/stop: close remaining, write exit_price + pnl +
//        closed_at + outcome, transition → exited.
//   3. Recompute equity = cash + Σ unrealized_pnl per user.
//   4. Write a dead-man's-switch heartbeat. If this function
//      stops running, the kill-switch trigger (in a future
//      migration) flips to engaged after N minutes without
//      heartbeat.
// ============================================================

import {
  fetchTickers,
  type Symbol,
  type Ticker,
} from "../_shared/market.ts";
import { SYMBOL_WHITELIST, validateDoctrineInvariants } from "../_shared/doctrine.ts";
import {
  appendTransition,
  evaluateTradeInCandle,
  transitionTrade,
  type InCandleAction,
  type LifecycleTransition,
  type TradeLifecyclePhase,
} from "../_shared/lifecycle.ts";
import { GATE_CODES, gate } from "../_shared/reasons.ts";

validateDoctrineInvariants();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface OpenTradeRow {
  id: string;
  user_id: string;
  symbol: string;
  side: "long" | "short";
  size: number;
  original_size: number | null;
  entry_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  tp1_price: number | null;
  tp1_filled: boolean | null;
  pnl: number | null;
  current_price: number | null;
  unrealized_pnl: number | null;
  lifecycle_phase: TradeLifecyclePhase | null;
  lifecycle_transitions: LifecycleTransition[] | null;
  status: string;
  strategy_id: string | null;
  strategy_version: string | null;
  notes: string | null;
}

// Convert a live ticker into a fake 1-bar "candle" so we can reuse
// the in-candle FSM for TP1/TP2/stop evaluation.
function tickerToSyntheticCandle(t: Ticker) {
  const p = t.price;
  // We don't know the intra-window high/low since we're using spot.
  // Use price itself as both — this is the conservative assumption:
  // trigger only on the current tick's price, not on spikes we didn't see.
  return { high: p, low: p, close: p };
}

// deno-lint-ignore no-explicit-any
async function runMarkToMarket(
  admin: any,
  opts: { userId?: string } = {},
) {
  const nowIso = new Date().toISOString();

  // 1. Load open trades. Cron path (no userId) processes every user globally
  //    via service role; user-JWT path scopes to the caller so a browser nudge
  //    never touches another user's positions.
  let openQuery = admin
    .from("trades")
    .select(
      "id,user_id,symbol,side,size,original_size,entry_price,stop_loss,take_profit,tp1_price,tp1_filled,pnl,current_price,unrealized_pnl,lifecycle_phase,lifecycle_transitions,status,strategy_id,strategy_version,notes",
    )
    .eq("status", "open");
  if (opts.userId) {
    openQuery = openQuery.eq("user_id", opts.userId);
  }
  const { data: openTrades, error: openErr } = await openQuery;

  if (openErr) {
    console.error("mark-to-market: openTrades query failed", openErr);
    return { processed: 0, error: openErr.message };
  }
  const trades: OpenTradeRow[] = openTrades ?? [];
  if (trades.length === 0) {
    return { processed: 0, updates: 0, closed: 0, tp1Fills: 0 };
  }

  // 2. De-duplicate symbols and fetch tickers in parallel.
  const uniqueSymbols = Array.from(
    new Set(trades.map((t) => t.symbol)),
  ).filter((s): s is Symbol =>
    (SYMBOL_WHITELIST as readonly string[]).includes(s),
  );
  const tickers = await fetchTickers(uniqueSymbols);

  // 3. Process each trade. Group per-user so we can roll equity after.
  const perUserChanges = new Map<
    string,
    { realizedDelta: number; unrealized: number }
  >();
  let updates = 0;
  let closed = 0;
  let tp1Fills = 0;

  for (const t of trades) {
    const ticker = tickers[t.symbol as Symbol];
    if (!ticker || !Number.isFinite(ticker.price)) continue;

    const px = ticker.price;
    const sideMult = t.side === "long" ? 1 : -1;
    const originalSize = Number(t.original_size ?? t.size);

    const action: InCandleAction = evaluateTradeInCandle({
      side: t.side,
      entryPrice: Number(t.entry_price),
      stopPrice: Number(t.stop_loss ?? (t.side === "long" ? 0 : Infinity)),
      tp1Price: t.tp1_price != null ? Number(t.tp1_price) : null,
      tp2Price: t.take_profit != null ? Number(t.take_profit) : null,
      originalSize,
      remainingSize: Number(t.size),
      tp1Filled: !!t.tp1_filled,
      candle: tickerToSyntheticCandle(ticker),
      stopAtBreakeven: !!t.tp1_filled,
    });

    const bucket = perUserChanges.get(t.user_id) ?? {
      realizedDelta: 0,
      unrealized: 0,
    };

    if (action.type === "hold") {
      // Only update price fields — no lifecycle change.
      const upnl = (px - Number(t.entry_price)) * Number(t.size) * sideMult;
      const upnlPct =
        ((px - Number(t.entry_price)) / Number(t.entry_price)) * 100 * sideMult;

      // Tiny-move throttle (1¢ threshold) — avoid write storms when nothing changed.
      const prev = t.current_price ?? 0;
      if (
        Math.abs(Number(prev) - px) >= 0.01 ||
        t.unrealized_pnl === null
      ) {
        await admin
          .from("trades")
          .update({
            current_price: px,
            unrealized_pnl: upnl,
            unrealized_pnl_pct: upnlPct,
          })
          .eq("id", t.id);
        updates += 1;
      }

      bucket.unrealized += upnl;
      perUserChanges.set(t.user_id, bucket);
      continue;
    }

    if (action.type === "tp1_fill") {
      tp1Fills += 1;
      const closedQty = action.closedQty;
      const fillPx = action.fillPrice;
      const realizedHalf =
        (fillPx - Number(t.entry_price)) * closedQty * sideMult;
      const runnerSize = Number(t.size) - closedQty;
      const runnerUpnl =
        (px - Number(t.entry_price)) * runnerSize * sideMult;
      const runnerUpnlPct =
        ((px - Number(t.entry_price)) / Number(t.entry_price)) * 100 * sideMult;

      const fsm = transitionTrade(t.lifecycle_phase ?? "entered", "tp1_hit", {
        actor: "engine",
        reason: `TP1 filled @ $${fillPx.toFixed(2)} — half closed, stop→BE`,
        meta: { realized: realizedHalf, fillPrice: fillPx },
      });
      const transition: LifecycleTransition = fsm.ok && fsm.transition
        ? fsm.transition
        : {
          phase: "tp1_hit",
          at: nowIso,
          by: "engine",
          reason: `TP1 @ $${fillPx.toFixed(2)}`,
        };
      const nextTransitions = appendTransition(
        t.lifecycle_transitions,
        transition,
      );

      await admin
        .from("trades")
        .update({
          size: runnerSize,
          tp1_filled: true,
          stop_loss: action.newStop, // breakeven (= entry)
          pnl: Number(t.pnl ?? 0) + realizedHalf,
          current_price: px,
          unrealized_pnl: runnerUpnl,
          unrealized_pnl_pct: runnerUpnlPct,
          lifecycle_phase: "tp1_hit",
          lifecycle_transitions: nextTransitions,
          notes:
            `${t.notes ?? ""}\nTP1 @ $${fillPx.toFixed(2)} → +$${realizedHalf.toFixed(2)} booked, runner active, stop→BE.`
              .trim(),
        })
        .eq("id", t.id);
      updates += 1;

      await admin.from("journal_entries").insert({
        user_id: t.user_id,
        kind: "trade",
        title: `TP1 hit · ${t.symbol} +$${realizedHalf.toFixed(2)}`,
        summary:
          `Booked half at $${fillPx.toFixed(2)}. Runner half stays open with stop at breakeven ($${Number(
            t.entry_price,
          ).toFixed(2)}). This is the compound machine working.`,
        tags: ["tp1", "ladder", t.symbol, t.strategy_version ?? "v2"].filter(
          Boolean,
        ),
      });

      bucket.realizedDelta += realizedHalf;
      bucket.unrealized += runnerUpnl;
      perUserChanges.set(t.user_id, bucket);
      continue;
    }

    if (action.type === "stop_hit" || action.type === "tp2_hit") {
      closed += 1;
      const closedQty = action.closedQty;
      const fillPx = action.fillPrice;
      const realizedClose =
        (fillPx - Number(t.entry_price)) * closedQty * sideMult;
      const cumulativePnl = Number(t.pnl ?? 0) + realizedClose;
      const pnlPct =
        ((fillPx - Number(t.entry_price)) / Number(t.entry_price)) *
        100 *
        sideMult;
      const outcome = cumulativePnl >= 0 ? "win" : "loss";
      const reason =
        action.type === "stop_hit"
          ? `Stop hit @ $${fillPx.toFixed(2)}`
          : `TP2 hit @ $${fillPx.toFixed(2)} — runner booked`;

      const fsm = transitionTrade(
        t.lifecycle_phase ?? (t.tp1_filled ? "tp1_hit" : "entered"),
        "exited",
        { actor: "engine", reason, meta: { fillPrice: fillPx, outcome } },
      );
      const transition: LifecycleTransition = fsm.ok && fsm.transition
        ? fsm.transition
        : { phase: "exited", at: nowIso, by: "engine", reason };
      const nextTransitions = appendTransition(
        t.lifecycle_transitions,
        transition,
      );

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
          notes: `${t.notes ?? ""}\n${reason} · realized $${realizedClose.toFixed(2)} · total $${cumulativePnl.toFixed(2)}`
            .trim(),
        })
        .eq("id", t.id);
      updates += 1;

      await admin.from("journal_entries").insert({
        user_id: t.user_id,
        kind: "trade",
        title: `${action.type === "stop_hit" ? "Stopped out" : "TP2 hit"} · ${t.symbol} ${cumulativePnl >= 0 ? "+" : ""}$${cumulativePnl.toFixed(2)}`,
        summary: reason,
        tags: [
          action.type,
          t.symbol,
          t.strategy_version ?? "v2",
          outcome,
        ].filter(Boolean),
      });

      bucket.realizedDelta += realizedClose;
      // Closed trade contributes 0 unrealized going forward.
      perUserChanges.set(t.user_id, bucket);
      continue;
    }
  }

  // 4. Per-user equity roll: cash += realizedDelta, equity = cash + Σunrealized.
  for (const [userId, change] of perUserChanges.entries()) {
    if (change.realizedDelta === 0 && change.unrealized === 0) continue;
    const { data: acct } = await admin
      .from("account_state")
      .select("cash,equity")
      .eq("user_id", userId)
      .maybeSingle();
    if (!acct) continue;
    const newCash = Number(acct.cash ?? 0) + change.realizedDelta;
    const newEquity = newCash + change.unrealized;
    await admin
      .from("account_state")
      .update({ cash: newCash, equity: newEquity })
      .eq("user_id", userId);
  }

  // 5. Dead-man's-switch heartbeat on every active system_state.
  await admin
    .from("system_state")
    .update({ last_mark_to_market_at: nowIso })
    .eq("bot", "running")
    .eq("kill_switch_engaged", false);

  return {
    processed: trades.length,
    updates,
    closed,
    tp1Fills,
    ranAt: nowIso,
  };
}

// ─── HTTP entry ─────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const { createClient } = await import(
      "https://esm.sh/@supabase/supabase-js@2.45.0"
    );
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Two invocation modes:
    //   1. Cron fanout: body.cronAll === true, Authorization: Bearer <cron-token>
    //   2. User JWT: Authorization: Bearer <jwt>, processes the caller only
    // deno-lint-ignore no-explicit-any
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const authHeader = req.headers.get("Authorization") ?? "";

    if (body?.cronAll === true) {
      const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
      const { data: tok } = await admin.rpc(
        "get_mark_to_market_cron_token",
      );
      if (!tok || tok !== bearer) {
        return new Response(
          JSON.stringify({
            error: gate(
              GATE_CODES.KILL_SWITCH,
              "halt",
              "mark-to-market cron token mismatch",
            ),
          }),
          {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      const result = await runMarkToMarket(admin);
      return new Response(JSON.stringify({ mode: "cron", ...result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // User JWT mode: refresh for this user's open trades only.
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // User-JWT mode: scope to the caller's open trades only. Service role is
    // still used for the writes (RLS-bypass), but we filter by user_id so a
    // browser nudge never spills into other users' positions.
    const result = await runMarkToMarket(admin, {
      userId: userData.user.id,
    });
    return new Response(
      JSON.stringify({ mode: "user", userId: userData.user.id, ...result }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error("mark-to-market error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
