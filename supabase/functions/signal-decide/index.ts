// ============================================================
// signal-decide — operator approve/reject on a pending signal.
// ------------------------------------------------------------
// Approve → transitionSignal("proposed" → "approved" → "executed")
//         + transitionTrade(seed "entered")
// Reject  → transitionSignal("proposed" → "rejected")
//
// Every status change flows through the FSM in _shared/lifecycle.ts
// so illegal jumps fail loudly instead of silently corrupting state.
// ============================================================

import {
  appendTransition,
  transitionSignal,
  transitionTrade,
  type LifecycleTransition,
  type SignalLifecyclePhase,
} from "../_shared/lifecycle.ts";
import { validateDoctrineInvariants } from "../_shared/doctrine.ts";
import {
  isSnapshotStale,
  snapshotAgeSeconds,
  STALE_SNAPSHOT_MAX_AGE_SECONDS,
} from "../_shared/snapshot.ts";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import {
  getBrokerCredentials,
  placeMarketBuy,
} from "../_shared/broker.ts";

validateDoctrineInvariants();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const signalId = String(body.signalId ?? "");
    const action = String(body.action ?? "");
    const reason = body.reason ? String(body.reason) : null;

    if (!signalId || !["approve", "reject"].includes(action)) {
      return new Response(
        JSON.stringify({
          error: "signalId and action ('approve'|'reject') required",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
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
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Rate limit: 20 req / 60s per user
    const rl = await checkRateLimit(admin, userId, "signal-decide", 20);
    if (!rl.allowed) return rateLimitResponse(rl, corsHeaders);

    const { data: sig, error: sigErr } = await admin
      .from("trade_signals")
      .select("*")
      .eq("id", signalId)
      .eq("user_id", userId)
      .maybeSingle();

    if (sigErr || !sig) {
      return new Response(JSON.stringify({ error: "Signal not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (sig.status !== "pending") {
      return new Response(
        JSON.stringify({ error: `Signal already ${sig.status}` }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const prevTransitions: LifecycleTransition[] = Array.isArray(
      sig.lifecycle_transitions,
    )
      ? sig.lifecycle_transitions
      : [];
    const currentPhase: SignalLifecyclePhase =
      (sig.lifecycle_phase as SignalLifecyclePhase | null) ?? "proposed";
    const nowIso = new Date().toISOString();

    // ── REJECT ──────────────────────────────────────────────
    if (action === "reject") {
      const result = transitionSignal(currentPhase, "rejected", {
        actor: "user",
        reason: reason ?? "Operator declined",
      });
      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: result.error ?? "Illegal transition" }),
          {
            status: 409,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      const transitions = appendTransition(prevTransitions, result.transition!);

      await admin
        .from("trade_signals")
        .update({
          status: "rejected",
          decided_by: "user",
          decision_reason: reason ?? "Operator declined",
          decided_at: nowIso,
          lifecycle_phase: "rejected",
          lifecycle_transitions: transitions,
        })
        .eq("id", signalId);

      await admin.from("journal_entries").insert({
        user_id: userId,
        kind: "skip",
        title: `Declined ${sig.side} @ $${Number(sig.proposed_entry).toFixed(0)}`,
        summary:
          reason ??
          `Operator rejected the AI proposal. AI confidence was ${(Number(sig.confidence) * 100).toFixed(0)}%.`,
        tags: [sig.regime, "rejected"],
      });

      return new Response(
        JSON.stringify({ ok: true, status: "rejected" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ── APPROVE: proposed → approved → executed ───────────────────
    //
    // P6-G: stale engine snapshot guard. If the engine cron has stalled,
    // gates can't be trusted and we must refuse the approval. The
    // operator can re-approve once the engine's caught up. Reject is
    // always allowed (declining a signal doesn't read the gate state).
    const { data: sysRow } = await admin
      .from("system_state")
      .select("last_engine_snapshot, live_trading_enabled")
      .eq("user_id", userId)
      .maybeSingle();
    const snap = sysRow?.last_engine_snapshot ?? null;
    const liveEnabled = !!sysRow?.live_trading_enabled;
    if (isSnapshotStale(snap)) {
      const ageSec = Math.round(snapshotAgeSeconds(snap));
      return new Response(
        JSON.stringify({
          error: "Engine snapshot is stale — refusing to execute.",
          code: "STALE_ENGINE_SNAPSHOT",
          meta: {
            snapshotAgeSeconds: Number.isFinite(ageSec) ? ageSec : null,
            maxAgeSeconds: STALE_SNAPSHOT_MAX_AGE_SECONDS,
          },
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const approveStep = transitionSignal(currentPhase, "approved", {
      actor: "user",
      reason: reason ?? "Operator approved",
    });
    if (!approveStep.ok) {
      return new Response(
        JSON.stringify({
          error: approveStep.error ?? "Illegal approval transition",
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    let entry = Number(sig.proposed_entry);
    const sizeUsd = Number(sig.size_usd);
    let size = sizeUsd / entry;
    const ctx = (sig.context_snapshot ?? {}) as {
      tp1?: number;
      pullback?: boolean;
    };
    const tp1Price = ctx?.tp1 != null ? Number(ctx.tp1) : null;
    const wasPullback = ctx?.pullback === true;

    const tags = ["ai-signal", sig.regime];
    if (wasPullback) tags.push("pullback");

    // ── LIVE MODE: place broker order BEFORE writing DB ────────────────
    // Fail-safe: if the broker call throws, we return 502 and write nothing
    // to the DB. This prevents ghost trades (DB says "open", no real position).
    let brokerOrderId: string | null = null;
    if (liveEnabled) {
      try {
        const creds = await getBrokerCredentials(admin);
        const fill = await placeMarketBuy(
          creds,
          sig.symbol,
          sizeUsd.toFixed(2), // spend exactly sizeUsd dollars
          crypto.randomUUID(),
        );
        // Use actual fill price and size (may differ slightly from proposed)
        entry = fill.fillPrice;
        size = fill.filledBaseSize;
        brokerOrderId = fill.orderId;
        console.log(
          `[signal-decide] LIVE BUY filled: ${sig.symbol} @ $${entry} ` +
            `size=${size} orderId=${brokerOrderId}`,
        );
      } catch (brokerErr) {
        const msg = brokerErr instanceof Error ? brokerErr.message : String(brokerErr);
        console.error("[signal-decide] Broker order failed:", msg);
        return new Response(
          JSON.stringify({
            error: "Broker order failed — trade NOT opened. Check Coinbase dashboard.",
            code: "BROKER_ORDER_FAILED",
            detail: msg,
          }),
          {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // Trade FSM seed: always "entered"
    const tradeEnteredResult = transitionTrade("entered", "entered", {
      actor: "user",
      reason: reason ?? "Operator approved",
      meta: { fromSignalId: signalId },
    });
    const tradeEnteredTransition: LifecycleTransition =
      tradeEnteredResult.ok && tradeEnteredResult.transition
        ? tradeEnteredResult.transition
        : {
          phase: "entered",
          at: nowIso,
          by: "user",
          reason: reason ?? "Operator approved",
          meta: { fromSignalId: signalId },
        };

    const { data: tradeRow, error: tradeErr } = await admin
      .from("trades")
      .insert({
        user_id: userId,
        symbol: sig.symbol,
        side: sig.side,
        direction_basis: sig.direction_basis ?? null,
        size,
        original_size: size,
        entry_price: entry,
        stop_loss: sig.proposed_stop !== null ? Number(sig.proposed_stop) : null,
        take_profit:
          sig.proposed_target !== null ? Number(sig.proposed_target) : null,
        tp1_price: tp1Price,
        tp1_filled: false,
        strategy_id: sig.strategy_id ?? null,
        strategy_version: sig.strategy_version ?? "signal-engine v2 (ladder)",
        lifecycle_phase: "entered",
        lifecycle_transitions: [tradeEnteredTransition],
        reason_tags: tags,
        notes: `${liveEnabled ? "LIVE " : ""}Operator-approved. AI confidence ${(Number(sig.confidence) * 100).toFixed(0)}%.${wasPullback ? " Pullback entry." : ""}${brokerOrderId ? ` Coinbase orderId: ${brokerOrderId}.` : ""}`,
        broker_order_id: brokerOrderId,
        status: "open",
        outcome: "open",
      })
      .select()
      .single();

    if (tradeErr) {
      console.error("trade insert failed", tradeErr);
      return new Response(JSON.stringify({ error: tradeErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // approved → executed
    const executeStep = transitionSignal("approved", "executed", {
      actor: "user",
      reason: reason ?? "Operator approved",
      meta: { tradeId: tradeRow?.id ?? null },
    });

    const nextTransitions: LifecycleTransition[] = [
      ...prevTransitions,
      approveStep.transition!,
      ...(executeStep.ok && executeStep.transition
        ? [executeStep.transition]
        : []),
    ];

    await admin
      .from("trade_signals")
      .update({
        status: "executed",
        decided_by: "user",
        decision_reason: reason ?? "Operator approved",
        decided_at: nowIso,
        executed_trade_id: tradeRow?.id ?? null,
        lifecycle_phase: "executed",
        lifecycle_transitions: nextTransitions,
      })
      .eq("id", signalId);

    await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "trade",
      title: `Opened ${sig.side} ${sig.symbol} @ $${entry.toFixed(0)}`,
      summary: `From AI signal. ${sig.ai_reasoning}`,
      tags: [sig.regime, "ai-signal"],
    });

    return new Response(
      JSON.stringify({ ok: true, status: "executed", trade: tradeRow }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error("signal-decide error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
