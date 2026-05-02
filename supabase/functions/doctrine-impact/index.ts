// ============================================================
// doctrine-impact — preview the impact of a proposed doctrine
// change against the last N days of CLOSED trades.
//
// This is a HEURISTIC backtest — not a re-simulation. It re-applies
// the new caps (max_order_usd, daily_loss_usd, max_trades_per_day)
// to historical trades to estimate how many would have been
// trimmed, halted, or skipped, and the rough P&L delta that would
// have produced.
//
// Input (POST):
//   { changes: [{ field, to_value }, ...], lookback_days?: number }
// Output:
//   { ok: true, lookback_days, before, after, delta, trade_count }
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";
import {
  resolveDoctrine,
  type DoctrineSettingsRow,
  type DoctrineField,
} from "../_shared/doctrine-resolver.ts";

interface ChangeRequest {
  field: DoctrineField;
  to_value: number;
}

interface Trade {
  id: string;
  symbol: string;
  size: number;        // base units
  entry_price: number;
  exit_price: number | null;
  pnl: number | null;
  closed_at: string | null;
  opened_at: string;
}

interface ImpactSummary {
  total_trades: number;
  total_pnl: number;
  trades_resized: number;
  trades_skipped_daily_cap: number;
  trades_skipped_count_cap: number;
  realized_loss_days_halted: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json({ error: "missing authorization" }, 401);

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userResp, error: uErr } = await userClient.auth.getUser();
    if (uErr || !userResp?.user) return json({ error: "invalid token" }, 401);
    const userId = userResp.user.id;

    const body = await req.json().catch(() => null);
    const changes: ChangeRequest[] = Array.isArray(body?.changes) ? body.changes : [];
    const lookbackDays = Math.max(1, Math.min(180, Number(body?.lookback_days ?? 30)));
    if (changes.length === 0) return json({ error: "no changes provided" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Pull current settings + closed trades inside lookback window.
    const sinceIso = new Date(Date.now() - lookbackDays * 86400_000).toISOString();
    const [{ data: settingsRow }, { data: account }, { data: tradesRows }] = await Promise.all([
      admin.from("doctrine_settings").select("*").eq("user_id", userId).maybeSingle(),
      admin.from("account_state").select("equity, start_of_day_equity").eq("user_id", userId).maybeSingle(),
      admin
        .from("trades")
        .select("id, symbol, size, entry_price, exit_price, pnl, closed_at, opened_at")
        .eq("user_id", userId)
        .eq("status", "closed")
        .gte("closed_at", sinceIso)
        .order("closed_at", { ascending: true })
        .limit(1000),
    ]);

    if (!settingsRow) return json({ error: "doctrine_settings missing" }, 500);
    const trades: Trade[] = (tradesRows ?? []) as Trade[];
    const equity = Number(account?.equity ?? 0) || 0;

    const before = settingsRow as DoctrineSettingsRow;
    const after: DoctrineSettingsRow = { ...before };
    for (const c of changes) {
      (after as unknown as Record<string, number>)[c.field] = c.to_value;
    }

    const beforeImpact = simulate(trades, before, equity);
    const afterImpact  = simulate(trades, after,  equity);

    return json({
      ok: true,
      lookback_days: lookbackDays,
      trade_count: trades.length,
      before: beforeImpact,
      after: afterImpact,
      delta: {
        total_pnl: afterImpact.total_pnl - beforeImpact.total_pnl,
        trades_resized: afterImpact.trades_resized - beforeImpact.trades_resized,
        trades_skipped_daily_cap: afterImpact.trades_skipped_daily_cap - beforeImpact.trades_skipped_daily_cap,
        trades_skipped_count_cap: afterImpact.trades_skipped_count_cap - beforeImpact.trades_skipped_count_cap,
        realized_loss_days_halted: afterImpact.realized_loss_days_halted - beforeImpact.realized_loss_days_halted,
      },
    });
  } catch (e) {
    console.error("[doctrine-impact] error", e);
    return json({ error: e instanceof Error ? e.message : "unknown error" }, 500);
  }
});

function simulate(trades: Trade[], settings: DoctrineSettingsRow, equity: number): ImpactSummary {
  const resolved = resolveDoctrine(settings, equity > 0 ? equity : 1);
  const summary: ImpactSummary = {
    total_trades: 0,
    total_pnl: 0,
    trades_resized: 0,
    trades_skipped_daily_cap: 0,
    trades_skipped_count_cap: 0,
    realized_loss_days_halted: 0,
  };

  // Bucket trades by UTC day.
  const byDay = new Map<string, Trade[]>();
  for (const t of trades) {
    const day = (t.closed_at ?? t.opened_at).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(t);
  }

  for (const [, dayTrades] of byDay) {
    let dayLossUsd = 0;
    let dayCount = 0;
    let halted = false;

    for (const t of dayTrades) {
      // Trades-per-day cap.
      if (dayCount >= resolved.maxTradesPerDay) {
        summary.trades_skipped_count_cap += 1;
        continue;
      }
      // Daily loss cap.
      if (dayLossUsd >= resolved.dailyLossUsd && resolved.dailyLossUsd > 0) {
        summary.trades_skipped_daily_cap += 1;
        if (!halted) { summary.realized_loss_days_halted += 1; halted = true; }
        continue;
      }

      // Resize check: original notional vs maxOrderUsd.
      const origNotional = Math.abs((t.size ?? 0) * (t.entry_price ?? 0));
      let scale = 1;
      if (origNotional > resolved.maxOrderUsd && origNotional > 0) {
        scale = resolved.maxOrderUsd / origNotional;
        summary.trades_resized += 1;
      }
      const scaledPnl = Number(t.pnl ?? 0) * scale;

      summary.total_trades += 1;
      summary.total_pnl += scaledPnl;
      dayCount += 1;
      if (scaledPnl < 0) dayLossUsd += -scaledPnl;
    }
  }

  // Round for display sanity.
  summary.total_pnl = Math.round(summary.total_pnl * 100) / 100;
  return summary;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
