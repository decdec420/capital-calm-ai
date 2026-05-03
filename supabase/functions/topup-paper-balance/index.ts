// ============================================================
// topup-paper-balance — operator-callable paper balance top-up.
// ------------------------------------------------------------
// account_state.cash / equity / start_of_day_equity are guarded
// by the `prevent_client_balance_tamper` trigger — only
// service_role can move them. This function is the legitimate
// path for a user to add to their PAPER balance.
//
// Hard-gated to mode = 'paper'. If live trading is armed we
// refuse, because in live mode equity must reflect actual broker
// cash, not synthetic top-ups.
//
// Body: { amount_usd: number }   (1 .. 1_000_000)
//
// Effects on success:
//   - account_state.cash               += amount
//   - account_state.equity             += amount
//   - account_state.start_of_day_equity = max(current, new equity)
//     (so the "Daily P&L" tile doesn't show a fake +$X gain)
//   - system_audit_log row with action = 'paper_topup'
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { makeCorsHeaders } from "../_shared/cors.ts";

interface TopupBody {
  amount_usd?: number;
}

Deno.serve(async (req) => {
  const cors = makeCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Auth: only the signed-in user can top up their own paper account.
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json({ error: "missing authorization" }, 401);

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userResp, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userResp?.user) return json({ error: "invalid token" }, 401);
    const userId = userResp.user.id;

    const body = (await req.json().catch(() => ({}))) as TopupBody;
    const amount = Number(body?.amount_usd);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "amount_usd must be a positive number" }, 400);
    }
    if (amount < 1) return json({ error: "minimum top-up is $1" }, 400);
    if (amount > 1_000_000) return json({ error: "maximum top-up is $1,000,000" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Refuse if live trading is armed — equity must mirror real broker cash there.
    const { data: sys, error: sysErr } = await admin
      .from("system_state")
      .select("mode, live_trading_enabled")
      .eq("user_id", userId)
      .maybeSingle();
    if (sysErr) throw sysErr;
    if (sys?.live_trading_enabled || (sys?.mode && sys.mode !== "paper")) {
      return json({
        error: "Top-up is paper-only. Disarm live trading first.",
      }, 409);
    }

    // Read current account_state.
    const { data: acct, error: acctErr } = await admin
      .from("account_state")
      .select("equity, cash, start_of_day_equity")
      .eq("user_id", userId)
      .maybeSingle();
    if (acctErr) throw acctErr;
    if (!acct) return json({ error: "account_state not found" }, 404);

    const newCash = Number(acct.cash) + amount;
    const newEquity = Number(acct.equity) + amount;
    // Prevent a fake "today's gain": bump SOD to at least the new equity.
    const newSod = Math.max(Number(acct.start_of_day_equity), newEquity);

    const { error: updErr } = await admin
      .from("account_state")
      .update({
        cash: newCash,
        equity: newEquity,
        start_of_day_equity: newSod,
      })
      .eq("user_id", userId);
    if (updErr) throw updErr;

    // Audit (best-effort; do not fail the call if the audit insert errors).
    try {
      await admin.from("system_audit_log").insert({
        user_id: userId,
        actor: "user",
        action: "paper_topup",
        amount_usd: amount,
        details: {
          previous_equity: Number(acct.equity),
          new_equity: newEquity,
          previous_cash: Number(acct.cash),
          new_cash: newCash,
        },
      } as never);
    } catch (e) {
      console.warn("[topup-paper-balance] audit insert failed (non-fatal):", e);
    }

    return json({
      ok: true,
      added_usd: amount,
      equity: newEquity,
      cash: newCash,
      start_of_day_equity: newSod,
    });
  } catch (e) {
    console.error("[topup-paper-balance] error:", e);
    return json({ error: e instanceof Error ? e.message : "unknown error" }, 500);
  }
});
