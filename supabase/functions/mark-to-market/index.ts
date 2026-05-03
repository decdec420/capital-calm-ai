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
  fetchCandles1m,
  fetchTickers,
  type Candle,
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
import {
  getBrokerCredentials,
  placeMarketSell,
  type BrokerCredentials,
} from "../_shared/broker.ts";
import { effectivePnl, recordFill } from "../_shared/fills.ts";
import { corsHeaders, makeCorsHeaders} from "../_shared/cors.ts";

validateDoctrineInvariants();


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

// Build a realistic 1-bar "candle" for the FSM. We prefer the most recent
// completed 1m bar's high/low (so TP/stop fire when the *bar* tagged the
// level — same realism as the loss path) and merge in the current spot
// price as the close. If the 1m fetch failed for any reason, we fall back
// to a flat synthetic bar built from spot, which is conservative: only the
// current tick can trigger an exit.
function buildEvaluationCandle(
  ticker: Ticker,
  recent1m: Candle | null,
): { high: number; low: number; close: number } {
  const p = ticker.price;
  if (recent1m && Number.isFinite(recent1m.h) && Number.isFinite(recent1m.l)) {
    return {
      high: Math.max(recent1m.h, p),
      low: Math.min(recent1m.l, p),
      close: p,
    };
  }
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

  // ── broker_failed alert sweep (cron path only) ───────────────────────
  // Surfaces any trade rows stuck in 'broker_failed' status so the operator
  // learns about unreconciled broker errors via Telegram rather than
  // discovering them manually. Only alerts for rows created in the last
  // 5 minutes so we don't spam on every tick for a pre-existing failure.
  // broker_failed rows are naturally excluded from the open trades query
  // above — they are never processed by the MTM engine.
  if (!opts.userId) {
    try {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: failedRows } = await admin
        .from("trades")
        .select("id,user_id,symbol,side,notes,created_at")
        .eq("status", "broker_failed")
        .gte("created_at", fiveMinAgo);
      for (const row of failedRows ?? []) {
        console.error("[mark-to-market] broker_failed trade detected:", row);
        await admin.rpc("notify_telegram", {
          p_user_id: row.user_id,
          p_event_type: "broker_failed",
          p_severity: "high",
          p_title: `⚠️ Broker order failed — ${row.symbol} ${row.side?.toUpperCase?.() ?? ""}`,
          p_message:
            `Trade ${row.id} is stuck in broker_failed status.\n` +
            `Error: ${row.notes ?? "unknown"}\n` +
            `Check Coinbase for an unrecorded position and reconcile manually.`,
        }).catch((e: unknown) => {
          console.error("notify_telegram (broker_failed) failed:", e);
        });
      }
    } catch (e) {
      // Non-fatal — don't let an alert sweep failure block the MTM tick.
      console.error("broker_failed sweep error (non-fatal):", e);
    }
  }

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

  // Pull the most-recent completed 1m candle per symbol so the FSM can
  // evaluate TP1/TP2/stop using the bar high/low — the same realism the
  // stop path always assumed. If a fetch fails, we fall back to spot only.
  const recent1m: Partial<Record<Symbol, Candle>> = {};
  await Promise.all(
    uniqueSymbols.map(async (sym) => {
      try {
        const candles = await fetchCandles1m(sym);
        if (candles.length > 0) {
          // fetchCandles returns ascending; take the most recent completed bar.
          recent1m[sym] = candles[candles.length - 1];
        }
      } catch (e) {
        console.warn(`[mark-to-market] 1m candle fetch failed for ${sym}:`, e);
      }
    }),
  );

  // 2b. Determine which users have live_trading_enabled.
  //     Broker credentials are loaded once if any live user has open trades.
  const uniqueUserIds = Array.from(new Set(trades.map((t) => t.user_id)));
  const { data: sysRows } = await admin
    .from("system_state")
    .select("user_id, live_trading_enabled")
    .in("user_id", uniqueUserIds);
  const liveUserIds = new Set<string>(
    (sysRows ?? [])
      .filter((r: { user_id: string; live_trading_enabled: boolean }) => !!r.live_trading_enabled)
      .map((r: { user_id: string }) => r.user_id),
  );
  let brokerCreds: BrokerCredentials | null = null;
  if (liveUserIds.size > 0) {
    try {
      brokerCreds = await getBrokerCredentials(admin);
    } catch (e) {
      // Fail-safe: log but don't block MTM from running in paper mode.
      // Live users' automated exits will be skipped until credentials are fixed.
      console.error(
        "[mark-to-market] Cannot load broker credentials — live-mode exits blocked:",
        e,
      );
    }
  }

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
      candle: buildEvaluationCandle(ticker, recent1m[t.symbol as Symbol] ?? null),
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
      let fillPx = action.fillPrice; // may be updated by broker fill in live mode
      let tp1BrokerOrderId: string | null = null;
      let tp1FeesUsd = 0;
      // deno-lint-ignore no-explicit-any
      let tp1Fill: any = null;

      // LIVE MODE: sell the TP1 half via broker before updating DB.
      // Optimistic lock (status='closing') prevents a concurrent cron run from
      // double-executing the same partial close.
      if (liveUserIds.has(t.user_id) && brokerCreds) {
        const { data: locked } = await admin
          .from("trades")
          .update({ status: "closing" })
          .eq("id", t.id)
          .eq("status", "open")
          .select("id");
        if (!locked || locked.length === 0) {
          // Another process already grabbed this trade — skip.
          perUserChanges.set(t.user_id, bucket);
          continue;
        }
        try {
          // Phase 5: deterministic clientOrderId per (trade, leg) means a
          // retried mark-to-market run cannot double-sell TP1.
          const tp1ClientOrderId = `${t.id}-tp1`;
          const fill = await placeMarketSell(
            brokerCreds,
            t.symbol,
            closedQty.toFixed(8),
            tp1ClientOrderId,
          );
          fillPx = fill.fillPrice;
          tp1BrokerOrderId = fill.orderId;
          tp1FeesUsd = Number.isFinite(fill.feesUsd) ? fill.feesUsd : 0;
          tp1Fill = fill;
          console.log(
            `[MTM] LIVE TP1 SELL filled ${t.symbol} qty=${closedQty} @ $${fillPx} ` +
              `orderId=${tp1BrokerOrderId} fees=$${tp1FeesUsd.toFixed(4)}`,
          );
        } catch (brokerErr) {
          // Revert lock — leave trade open so the next tick can retry.
          await admin.from("trades").update({ status: "open" }).eq("id", t.id);
          console.error(`[MTM] TP1 broker sell failed for trade ${t.id}:`, brokerErr);
          tp1Fills -= 1;
          perUserChanges.set(t.user_id, bucket);
          continue;
        }
      }

      if (tp1Fill) {
        await recordFill(admin, {
          userId: t.user_id,
          tradeId: t.id,
          symbol: t.symbol,
          fillKind: "tp1",
          proposedPrice: Number(t.tp1_price ?? action.fillPrice),
          fill: tp1Fill,
        });
      }

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
          // Reset from 'closing' (live lock) back to 'open' — runner is still active.
          status: "open",
          size: runnerSize,
          tp1_filled: true,
          stop_loss: action.newStop, // breakeven (= entry)
          pnl: Number(t.pnl ?? 0) + realizedHalf,
          current_price: px,
          unrealized_pnl: runnerUpnl,
          unrealized_pnl_pct: runnerUpnlPct,
          // Phase 5: accumulate partial-close fees so the final
          // effective_pnl at exit reflects every fee paid on the round-trip.
          exit_fees_usd: Number(t.exit_fees_usd ?? 0) + tp1FeesUsd,
          lifecycle_phase: "tp1_hit",
          lifecycle_transitions: nextTransitions,
          notes:
            `${t.notes ?? ""}${tp1BrokerOrderId ? "\nLIVE " : "\n"}TP1 @ $${fillPx.toFixed(2)} → +$${realizedHalf.toFixed(2)} booked${tp1FeesUsd > 0 ? ` (fees $${tp1FeesUsd.toFixed(4)})` : ""}, runner active, stop→BE.${tp1BrokerOrderId ? ` Coinbase orderId: ${tp1BrokerOrderId}.` : ""}`
              .trim(),
          ...(tp1BrokerOrderId ? { broker_order_id: tp1BrokerOrderId } : {}),
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
      let fillPx = action.fillPrice; // may be updated by broker fill in live mode
      let closeBrokerOrderId: string | null = null;

      // LIVE MODE: sell remaining position via broker before closing DB record.
      // Optimistic lock (status='closing') prevents double-close on concurrent runs.
      if (liveUserIds.has(t.user_id) && brokerCreds) {
        const { data: locked } = await admin
          .from("trades")
          .update({ status: "closing" })
          .eq("id", t.id)
          .eq("status", "open")
          .select("id");
        if (!locked || locked.length === 0) {
          // Another process already grabbed this trade — skip.
          closed -= 1;
          perUserChanges.set(t.user_id, bucket);
          continue;
        }
        try {
          const fill = await placeMarketSell(
            brokerCreds,
            t.symbol,
            closedQty.toFixed(8),
            crypto.randomUUID(),
          );
          fillPx = fill.fillPrice;
          closeBrokerOrderId = fill.orderId;
          console.log(
            `[MTM] LIVE ${action.type.toUpperCase()} SELL filled ${t.symbol} ` +
              `qty=${closedQty} @ $${fillPx} orderId=${closeBrokerOrderId}`,
          );
        } catch (brokerErr) {
          // Revert lock — trade stays open so the next tick can retry.
          await admin.from("trades").update({ status: "open" }).eq("id", t.id);
          console.error(
            `[MTM] ${action.type} broker sell failed for trade ${t.id}:`,
            brokerErr,
          );
          closed -= 1;
          perUserChanges.set(t.user_id, bucket);
          continue;
        }
      }

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
          ? `${closeBrokerOrderId ? "LIVE " : ""}Stop hit @ $${fillPx.toFixed(2)}`
          : `${closeBrokerOrderId ? "LIVE " : ""}TP2 hit @ $${fillPx.toFixed(2)} — runner booked`;

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
          notes: `${t.notes ?? ""}\n${reason} · realized $${realizedClose.toFixed(2)} · total $${cumulativePnl.toFixed(2)}${closeBrokerOrderId ? ` · Coinbase orderId: ${closeBrokerOrderId}` : ""}`
            .trim(),
          ...(closeBrokerOrderId ? { broker_close_order_id: closeBrokerOrderId } : {}),
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
    const cors = makeCorsHeaders(req);
if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
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
            headers: { ...cors, "Content-Type": "application/json" },
          },
        );
      }
      const result = await runMarkToMarket(admin);
      return new Response(JSON.stringify({ mode: "cron", ...result }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // User JWT mode: refresh for this user's open trades only.
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
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

    // User-JWT mode: scope to the caller's open trades only. Service role is
    // still used for the writes (RLS-bypass), but we filter by user_id so a
    // browser nudge never spills into other users' positions.
    const result = await runMarkToMarket(admin, {
      userId: userData.user.id,
    });
    return new Response(
      JSON.stringify({ mode: "user", userId: userData.user.id, ...result }),
      {
        headers: { ...cors, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error("mark-to-market error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }),
      {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      },
    );
  }
});
