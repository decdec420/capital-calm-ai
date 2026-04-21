// signal-decide — handle user approve/reject on a pending signal.
// Approve → open a trade row, mark signal executed, journal it.
// Reject → mark signal rejected, journal the skip with reason (AI learns).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

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
      return new Response(JSON.stringify({ error: "signalId and action ('approve'|'reject') required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.0");
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
      return new Response(JSON.stringify({ error: `Signal already ${sig.status}` }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const prevTransitions = Array.isArray(sig.lifecycle_transitions) ? sig.lifecycle_transitions : [];
    const nowIso = new Date().toISOString();

    if (action === "reject") {
      const transitions = [
        ...prevTransitions,
        { phase: "rejected", at: nowIso, by: "user", reason: reason ?? "Operator declined" },
      ];
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
        summary: reason ?? `Operator rejected the AI proposal. AI confidence was ${(Number(sig.confidence) * 100).toFixed(0)}%.`,
        tags: [sig.regime, "rejected"],
      });

      return new Response(JSON.stringify({ ok: true, status: "rejected" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // APPROVE → open trade
    const entry = Number(sig.proposed_entry);
    const sizeUsd = Number(sig.size_usd);
    const size = sizeUsd / entry;
    const ctx = (sig.context_snapshot ?? {}) as any;
    const tp1Price = ctx?.tp1 != null ? Number(ctx.tp1) : null;
    const wasPullback = ctx?.pullback === true;

    const tags = ["ai-signal", sig.regime];
    if (wasPullback) tags.push("pullback");

    const tradeEnteredTransition = {
      phase: "entered",
      at: nowIso,
      by: "user",
      reason: reason ?? "Operator approved",
      fromSignalId: signalId,
    };

    const { data: tradeRow, error: tradeErr } = await admin
      .from("trades")
      .insert({
        user_id: userId,
        symbol: sig.symbol,
        side: sig.side,
        size,
        original_size: size,
        entry_price: entry,
        stop_loss: sig.proposed_stop !== null ? Number(sig.proposed_stop) : null,
        take_profit: sig.proposed_target !== null ? Number(sig.proposed_target) : null,
        tp1_price: tp1Price,
        tp1_filled: false,
        strategy_id: sig.strategy_id ?? null,
        strategy_version: sig.strategy_version ?? "signal-engine v2 (ladder)",
        lifecycle_phase: "entered",
        lifecycle_transitions: [tradeEnteredTransition],
        reason_tags: tags,
        notes: `Operator-approved. AI confidence ${(Number(sig.confidence) * 100).toFixed(0)}%.${wasPullback ? " Pullback entry." : ""}`,
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

    const sigExecutedTransition = {
      phase: "executed",
      at: nowIso,
      by: "user",
      reason: reason ?? "Operator approved",
      tradeId: tradeRow?.id ?? null,
    };

    await admin
      .from("trade_signals")
      .update({
        status: "executed",
        decided_by: "user",
        decision_reason: reason ?? "Operator approved",
        decided_at: nowIso,
        executed_trade_id: tradeRow?.id ?? null,
        lifecycle_phase: "executed",
        lifecycle_transitions: [...prevTransitions, sigExecutedTransition],
      })
      .eq("id", signalId);

    await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "trade",
      title: `Opened ${sig.side} ${sig.symbol} @ $${entry.toFixed(0)}`,
      summary: `From AI signal. ${sig.ai_reasoning}`,
      tags: [sig.regime, "ai-signal"],
    });

    return new Response(JSON.stringify({ ok: true, status: "executed", trade: tradeRow }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("signal-decide error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
