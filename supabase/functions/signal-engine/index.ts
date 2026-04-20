// signal-engine — the AI's tick loop.
// PERCEIVE → ANALYZE → GATE → DECIDE → PROPOSE → EXECUTE → LEARN
// Triggered manually from the UI ("Run now") or by pg_cron in Phase 2.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

function computeRegime(candles: Candle[]) {
  if (candles.length < 20) {
    return {
      regime: "range",
      confidence: 0,
      volatility: "normal",
      setupScore: 0,
      todScore: 0.5,
      pctChange: 0,
      annualizedVolPct: 0,
      noTradeReasons: ["Not enough data"],
    };
  }
  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1];
  const first = closes[0];
  const pctChange = ((last - first) / first) * 100;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const stdev = Math.sqrt(variance);
  const annualizedVolPct = stdev * Math.sqrt(24 * 365) * 100;
  let volatility = "normal";
  if (annualizedVolPct < 30) volatility = "low";
  else if (annualizedVolPct > 80) volatility = "elevated";
  if (annualizedVolPct > 140) volatility = "extreme";
  const high = Math.max(...candles.map((c) => c.h));
  const low = Math.min(...candles.map((c) => c.l));
  const rangePct = ((high - low) / low) * 100;
  const driftRatio = Math.abs(pctChange) / Math.max(rangePct, 0.01);
  let regime = "range";
  if (driftRatio > 0.55) regime = pctChange > 0 ? "trending_up" : "trending_down";
  else if (rangePct < 0.8) regime = "chop";
  const prior20High = Math.max(...candles.slice(-21, -1).map((c) => c.h));
  if (last > prior20High * 1.001) regime = "breakout";
  const confidence = Math.min(1, Math.max(0.25, driftRatio * 1.2));
  const hour = new Date().getUTCHours();
  const todScore = hour >= 13 && hour < 21 ? 0.85 : hour >= 7 && hour < 23 ? 0.55 : 0.3;
  const trendBoost = regime === "trending_up" || regime === "breakout" ? 0.25 : regime === "trending_down" ? 0.1 : 0;
  const volBoost = volatility === "normal" ? 0.2 : volatility === "low" ? 0.05 : 0;
  const setupScore = Math.min(1, Math.max(0, confidence * 0.4 + todScore * 0.3 + trendBoost + volBoost));
  const noTradeReasons: string[] = [];
  if (setupScore < 0.65) noTradeReasons.push(`Setup score ${setupScore.toFixed(2)} below 0.65`);
  if (volatility === "extreme") noTradeReasons.push("Volatility extreme");
  if (regime === "chop") noTradeReasons.push("Chop — no edge");
  if (todScore < 0.4) noTradeReasons.push("Outside prime liquidity window");
  return { regime, confidence, volatility, setupScore, todScore, pctChange, annualizedVolPct, noTradeReasons };
}

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

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

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

    // STAGE 1 — PERCEIVE: pull live candles
    const cbResp = await fetch("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600");
    if (!cbResp.ok) throw new Error(`Coinbase ${cbResp.status}`);
    const raw = (await cbResp.json()) as number[][];
    const sorted = [...raw].sort((a, b) => a[0] - b[0]);
    const candles: Candle[] = sorted.map(([t, l, h, o, c, v]) => ({ t, l, h, o, c, v }));
    const lastPrice = candles[candles.length - 1].c;

    // STAGE 2 — ANALYZE: deterministic regime
    const r = computeRegime(candles);

    // STAGE 3 — GATE: kill-switch + bot status + open position check
    const [{ data: sys }, { data: acct }, { data: rails }, { data: openTrades }, { data: pendingSignals }, { data: recentSignals }] =
      await Promise.all([
        admin.from("system_state").select("*").eq("user_id", userId).maybeSingle(),
        admin.from("account_state").select("*").eq("user_id", userId).maybeSingle(),
        admin.from("guardrails").select("label,level,utilization,current_value,limit_value").eq("user_id", userId),
        admin.from("trades").select("id,symbol,side").eq("user_id", userId).eq("status", "open"),
        admin.from("trade_signals").select("id").eq("user_id", userId).eq("status", "pending").gte("expires_at", new Date().toISOString()),
        admin
          .from("trade_signals")
          .select("side,status,confidence,decision_reason,decided_by,created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

    if (!sys) throw new Error("System state missing");

    const halts: string[] = [];
    if (sys.kill_switch_engaged) halts.push("kill-switch engaged");
    if (sys.bot === "halted") halts.push("bot halted");
    if ((openTrades?.length ?? 0) > 0) halts.push("position already open");
    if ((pendingSignals?.length ?? 0) > 0) halts.push("signal already pending");
    const blockedRail = (rails ?? []).find((g: any) => g.level === "blocked");
    if (blockedRail) halts.push(`guardrail blocked: ${blockedRail.label}`);

    if (halts.length > 0) {
      return new Response(
        JSON.stringify({
          tick: "halted",
          reasons: halts,
          regime: r,
          lastPrice,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // STAGE 4 — DECIDE: AI reasons over the situation
    const contextPacket = {
      market: { lastPrice, ...r },
      account: acct ? { equity: Number(acct.equity), floor: Number(acct.balance_floor) } : null,
      guardrails: (rails ?? []).map((g: any) => ({
        label: g.label,
        level: g.level,
        util: Number(g.utilization),
        current: g.current_value,
        limit: g.limit_value,
      })),
      recentDecisions: (recentSignals ?? []).map((s: any) => ({
        side: s.side,
        status: s.status,
        confidence: Number(s.confidence),
        decidedBy: s.decided_by,
        reason: s.decision_reason,
      })),
    };

    const systemPrompt = `You are the Trader OS Signal Engine for BTC-USD.
You are disciplined, conservative, and risk-first. A SKIP is not a failure — it is data.
You may PROPOSE_TRADE only when ALL are true:
- setupScore >= 0.65
- regime is trending_up, trending_down, or breakout (never chop or pure range)
- volatility is not extreme
- no guardrail is in 'blocked' state and none above 0.85 utilization
Otherwise you MUST output decision="skip" with a clear reason.

Sizing rules:
- size_pct between 0.10 and 0.25 (% of equity), scaled by confidence
- stop: ~1.5% from entry (long: entry * 0.985, short: entry * 1.015)
- target: ~3% from entry (2:1 R:R minimum)

You MUST call the submit_decision tool with structured output. Do not respond in plain text.`;

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Tick at ${new Date().toISOString()}.\nContext:\n${JSON.stringify(contextPacket, null, 2)}\n\nDecide.`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "submit_decision",
              description: "Submit a trading decision: propose a trade or skip with reasoning.",
              parameters: {
                type: "object",
                properties: {
                  decision: { type: "string", enum: ["propose_trade", "skip"] },
                  side: { type: "string", enum: ["long", "short"] },
                  confidence: { type: "number", description: "0..1 confidence in this decision" },
                  size_pct: { type: "number", description: "Position size as % of equity, 0.10-0.25" },
                  proposed_entry: { type: "number", description: "Entry price (use current lastPrice)" },
                  proposed_stop: { type: "number", description: "Stop loss price" },
                  proposed_target: { type: "number", description: "Take profit price" },
                  reasoning: { type: "string", description: "2-4 sentence explanation. Witty but precise. No emojis." },
                },
                required: ["decision", "confidence", "reasoning"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "submit_decision" } },
      }),
    });

    if (!aiResp.ok) {
      if (aiResp.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited. Try again in a moment." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResp.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Top up in Workspace usage." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await aiResp.text();
      console.error("AI gateway error", aiResp.status, t);
      return new Response(JSON.stringify({ error: "AI gateway failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiJson = await aiResp.json();
    const toolCall = aiJson.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      return new Response(
        JSON.stringify({ tick: "no_decision", error: "AI returned no tool call", raw: aiJson }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let decision: any;
    try {
      decision = JSON.parse(toolCall.function.arguments);
    } catch {
      return new Response(JSON.stringify({ tick: "parse_error", raw: toolCall.function.arguments }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STAGE 5 — PROPOSE / SKIP
    if (decision.decision === "skip") {
      // Log skip as journal entry so the AI learns
      await admin.from("journal_entries").insert({
        user_id: userId,
        kind: "skip",
        title: `Engine skipped @ $${lastPrice.toFixed(0)} · ${r.regime}`,
        summary: decision.reasoning ?? "AI chose to skip.",
        tags: [r.regime, r.volatility],
      });
      return new Response(
        JSON.stringify({
          tick: "skipped",
          reasoning: decision.reasoning,
          regime: r,
          lastPrice,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // PROPOSE_TRADE
    const equity = acct ? Number(acct.equity) : 10000;
    const sizePct = Math.max(0.05, Math.min(0.25, Number(decision.size_pct ?? 0.15)));
    const sizeUsd = equity * sizePct;
    const entry = Number(decision.proposed_entry ?? lastPrice);
    const stop = Number(decision.proposed_stop ?? (decision.side === "long" ? entry * 0.985 : entry * 1.015));
    const target = Number(decision.proposed_target ?? (decision.side === "long" ? entry * 1.03 : entry * 0.97));

    const { data: signalRow, error: insertErr } = await admin
      .from("trade_signals")
      .insert({
        user_id: userId,
        symbol: "BTC-USD",
        side: decision.side ?? "long",
        confidence: Math.max(0, Math.min(1, Number(decision.confidence ?? 0.5))),
        setup_score: r.setupScore,
        regime: r.regime,
        proposed_entry: entry,
        proposed_stop: stop,
        proposed_target: target,
        size_usd: sizeUsd,
        size_pct: sizePct,
        ai_reasoning: decision.reasoning ?? "",
        ai_model: "google/gemini-3-flash-preview",
        context_snapshot: { regime: r, lastPrice },
        status: "pending",
      })
      .select()
      .single();

    if (insertErr) {
      console.error("signal insert failed", insertErr);
      return new Response(JSON.stringify({ error: insertErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STAGE 6 — EXECUTE (autonomy-gated)
    const autonomy = sys.autonomy_level ?? "manual";
    const autoApprove =
      autonomy === "autonomous" ||
      (autonomy === "assisted" && Number(decision.confidence ?? 0) >= 0.85);

    if (autoApprove) {
      // Open the trade now
      const { data: tradeRow } = await admin
        .from("trades")
        .insert({
          user_id: userId,
          symbol: "BTC-USD",
          side: decision.side ?? "long",
          size: sizeUsd / entry,
          entry_price: entry,
          stop_loss: stop,
          take_profit: target,
          strategy_version: "signal-engine v1",
          reason_tags: ["ai-signal", r.regime],
          notes: `Auto-approved (${autonomy}) @ confidence ${(Number(decision.confidence) * 100).toFixed(0)}%`,
          status: "open",
          outcome: "open",
        })
        .select()
        .single();

      await admin
        .from("trade_signals")
        .update({
          status: "executed",
          decided_by: "auto",
          decision_reason: `Auto-approved (${autonomy})`,
          decided_at: new Date().toISOString(),
          executed_trade_id: tradeRow?.id ?? null,
        })
        .eq("id", signalRow.id);
    }

    return new Response(
      JSON.stringify({
        tick: autoApprove ? "executed" : "proposed",
        signal: signalRow,
        autonomy,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("signal-engine error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
