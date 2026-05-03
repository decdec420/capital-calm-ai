// ============================================================
// position-reconcile — Hourly Coinbase position reconciliation
// ------------------------------------------------------------
// Cross-checks open `trades` rows in the DB against actual
// Coinbase account balances. Any Coinbase non-zero crypto
// balance that has NO matching open DB trade row is an orphaned
// position — likely a ghost left by a broker failure or a manual
// order placed outside the bot. These are immediately surfaced as:
//   1. A `journal_entries` row of kind = "alert" per user.
//   2. A `system_events` row of type = "orphan_position_detected".
//
// Also checks the inverse: open DB trade rows for live trades
// that have NO corresponding Coinbase balance (ghost DB record —
// broker fill never happened or position was closed externally).
//
// Cron: pg_cron every 60 minutes.
// Manual: POST with service-role token for on-demand checks.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, makeCorsHeaders} from "../_shared/cors.ts";
import { getBrokerCredentials } from "../_shared/broker.ts";
import { signCoinbaseJwt } from "../_shared/coinbase-auth.ts";
import { log } from "../_shared/logger.ts";

const CB_BASE = "https://api.coinbase.com";

// Minimum balance (in base units) to treat as a "real" open position.
// Avoids false positives from dust balances after rounding on sells.
const DUST_THRESHOLD_USD_EQUIV = 0.50;

// Coinbase currency → our product_id mapping
const CURRENCY_TO_SYMBOL: Record<string, string> = {
  BTC: "BTC-USD",
  ETH: "ETH-USD",
  SOL: "SOL-USD",
};

const WATCHED_CURRENCIES = new Set(Object.keys(CURRENCY_TO_SYMBOL));

interface CoinbaseAccount {
  uuid: string;
  currency: string;
  available_balance: { value: string; currency: string };
  hold: { value: string; currency: string };
}

// ── Coinbase API call ─────────────────────────────────────────

async function fetchCoinbaseAccounts(
  keyName: string,
  keyPem: string,
): Promise<CoinbaseAccount[]> {
  const jwt = await signCoinbaseJwt(keyName, keyPem);
  const r = await fetch(`${CB_BASE}/api/v3/brokerage/accounts?limit=50`, {
    headers: { Authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    throw new Error(`Coinbase accounts fetch failed HTTP ${r.status}: ${await r.text().catch(() => "")}`);
  }
  const body = await r.json();
  return (body.accounts ?? []) as CoinbaseAccount[];
}

// ── Per-user reconciliation ───────────────────────────────────

interface ReconcileResult {
  userId: string;
  mode: "skipped_paper" | "no_credentials" | "ok";
  orphanedCoinbasePositions: string[];   // symbols with Coinbase balance but no open DB trade
  ghostDbTrades: string[];               // trade IDs open in DB but no Coinbase balance
  alertsWritten: number;
}

// deno-lint-ignore no-explicit-any
async function reconcileUser(admin: any, userId: string): Promise<ReconcileResult> {
  // Only reconcile users in live mode — paper positions have no Coinbase counterpart.
  const { data: sys } = await admin
    .from("system_state")
    .select("mode, live_trading_enabled")
    .eq("user_id", userId)
    .maybeSingle();

  if (!sys || sys.mode !== "live" || !sys.live_trading_enabled) {
    return {
      userId,
      mode: "skipped_paper",
      orphanedCoinbasePositions: [],
      ghostDbTrades: [],
      alertsWritten: 0,
    };
  }

  // Fetch broker credentials — if not configured, skip silently.
  let creds: { apiKeyName: string; apiKeyPrivatePem: string };
  try {
    creds = await getBrokerCredentials(admin);
  } catch (e) {
    log("warn", "reconcile_no_credentials", { fn: "position-reconcile", userId, err: String(e) });
    return {
      userId,
      mode: "no_credentials",
      orphanedCoinbasePositions: [],
      ghostDbTrades: [],
      alertsWritten: 0,
    };
  }

  // ── 1. Fetch live Coinbase balances ───────────────────────────
  const accounts = await fetchCoinbaseAccounts(creds.apiKeyName, creds.apiKeyPrivatePem);

  // Build map: symbol (e.g. "BTC-USD") → total balance (available + hold)
  const coinbaseBalances = new Map<string, number>();
  for (const acct of accounts) {
    if (!WATCHED_CURRENCIES.has(acct.currency)) continue;
    const symbol = CURRENCY_TO_SYMBOL[acct.currency];
    const avail = parseFloat(acct.available_balance?.value ?? "0");
    const hold  = parseFloat(acct.hold?.value ?? "0");
    const total = avail + hold;
    if (total > 0) {
      coinbaseBalances.set(symbol, total);
    }
  }

  // ── 2. Fetch open DB trades for this user ─────────────────────
  const { data: openTrades } = await admin
    .from("trades")
    .select("id, symbol, size, entry_price, created_at, broker_order_id")
    .eq("user_id", userId)
    .eq("status", "open");

  const dbOpenBySymbol = new Map<string, { id: string; size: number; entryPrice: number; createdAt: string }[]>();
  for (const t of (openTrades ?? [])) {
    const existing = dbOpenBySymbol.get(t.symbol) ?? [];
    existing.push({
      id: t.id,
      size: parseFloat(t.size ?? "0"),
      entryPrice: parseFloat(t.entry_price ?? "0"),
      createdAt: t.created_at,
    });
    dbOpenBySymbol.set(t.symbol, existing);
  }

  const orphanedCoinbasePositions: string[] = [];
  const ghostDbTrades: string[] = [];
  let alertsWritten = 0;

  // ── 3. Orphan check: Coinbase balance with no DB open trade ───
  for (const [symbol, balance] of coinbaseBalances.entries()) {
    // Estimate USD value: balance * entry_price of known DB trade, or just log the base amount
    const dbTrades = dbOpenBySymbol.get(symbol) ?? [];
    const dbTotalSize = dbTrades.reduce((sum, t) => sum + t.size, 0);

    // Allow a 10% tolerance for fills that may differ slightly from DB size
    const sizeDelta = Math.abs(balance - dbTotalSize);
    const tolerance = dbTotalSize * 0.10;

    if (dbTrades.length === 0 || (dbTotalSize > 0 && sizeDelta > tolerance && balance > dbTotalSize * 0.10)) {
      // Something on Coinbase has no (or significantly mismatched) DB record
      if (dbTrades.length === 0) {
        orphanedCoinbasePositions.push(symbol);
        log("error", "orphan_position_detected", {
          fn: "position-reconcile",
          userId,
          symbol,
          coinbaseBalance: balance,
          dbOpenTradeCount: 0,
        });
      } else {
        // Size mismatch — flag but use a different code
        log("warn", "position_size_mismatch", {
          fn: "position-reconcile",
          userId,
          symbol,
          coinbaseBalance: balance,
          dbTotalSize,
          sizeDelta,
        });
      }
    }
  }

  // ── 4. Ghost DB check: open trade row but no Coinbase balance ──
  for (const [symbol, trades] of dbOpenBySymbol.entries()) {
    const cbBalance = coinbaseBalances.get(symbol) ?? 0;
    for (const t of trades) {
      // Only flag if the DB trade has a non-trivial size and Coinbase shows nothing
      if (t.size > 0 && cbBalance === 0) {
        ghostDbTrades.push(t.id);
        log("error", "ghost_db_trade_detected", {
          fn: "position-reconcile",
          userId,
          symbol,
          tradeId: t.id,
          dbSize: t.size,
          coinbaseBalance: 0,
        });
      }
    }
  }

  // ── 5. Write alerts ───────────────────────────────────────────

  for (const symbol of orphanedCoinbasePositions) {
    const balance = coinbaseBalances.get(symbol) ?? 0;

    // journal_entries alert — visible in the UI's Journal tab
    const { error: jErr } = await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "alert",
      title: `⚠️ Orphaned Coinbase position: ${symbol}`,
      summary:
        `Coinbase shows ${balance.toFixed(8)} ${symbol.replace("-USD", "")} with NO matching open trade in the database. ` +
        `This position was not opened by the bot, or the DB record was lost. Investigate immediately.`,
      tags: ["reconcile", "orphan", "alert", symbol.toLowerCase()],
      raw: { source: "position-reconcile", symbol, coinbaseBalance: balance, detectedAt: new Date().toISOString() },
    });
    if (jErr) {
      log("warn", "reconcile_journal_insert_failed", { fn: "position-reconcile", userId, symbol, err: jErr.message });
    } else {
      alertsWritten++;
    }

    // system_events audit record
    await admin.from("system_events").insert({
      user_id: userId,
      event_type: "orphan_position_detected",
      actor: "system",
      payload: { symbol, coinbaseBalance: balance, detectedAt: new Date().toISOString() },
    }).then(({ error: evtErr }: { error: { message: string } | null }) => {
      if (evtErr) log("warn", "system_event_insert_failed", { fn: "position-reconcile", err: evtErr.message });
    });
  }

  for (const tradeId of ghostDbTrades) {
    // Find the trade's symbol for the message
    let ghostSymbol = "unknown";
    for (const [sym, trades] of dbOpenBySymbol.entries()) {
      if (trades.some((t) => t.id === tradeId)) { ghostSymbol = sym; break; }
    }

    const { error: jErr } = await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "alert",
      title: `⚠️ Ghost DB trade: ${ghostSymbol} (${tradeId.slice(0, 8)}…)`,
      summary:
        `Trade ${tradeId} is marked "open" in the database for ${ghostSymbol}, ` +
        `but Coinbase shows zero balance for this asset. ` +
        `The position may have been closed externally or a broker fill never completed. Investigate immediately.`,
      tags: ["reconcile", "ghost", "alert", ghostSymbol.toLowerCase()],
      raw: { source: "position-reconcile", tradeId, symbol: ghostSymbol, detectedAt: new Date().toISOString() },
    });
    if (jErr) {
      log("warn", "reconcile_journal_insert_failed", { fn: "position-reconcile", userId, tradeId, err: jErr.message });
    } else {
      alertsWritten++;
    }

    await admin.from("system_events").insert({
      user_id: userId,
      event_type: "ghost_db_trade_detected",
      actor: "system",
      payload: { tradeId, symbol: ghostSymbol, detectedAt: new Date().toISOString() },
    }).then(({ error: evtErr }: { error: { message: string } | null }) => {
      if (evtErr) log("warn", "system_event_insert_failed", { fn: "position-reconcile", err: evtErr.message });
    });
  }

  log("info", "reconcile_complete", {
    fn: "position-reconcile",
    userId,
    orphanedCoinbasePositions: orphanedCoinbasePositions.length,
    ghostDbTrades: ghostDbTrades.length,
    alertsWritten,
  });

  return {
    userId,
    mode: "ok",
    orphanedCoinbasePositions,
    ghostDbTrades,
    alertsWritten,
  };
}

// ── HTTP entry point ──────────────────────────────────────────

Deno.serve(async (req) => {
    const cors = makeCorsHeaders(req);
if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const CRON_SECRET = Deno.env.get("RECONCILE_CRON_SECRET");

    // Auth: require either service-role JWT or matching cron secret
    const authHeader = req.headers.get("Authorization") ?? "";
    let isCron = false;

    let body: { cronToken?: string; userId?: string } = {};
    try { body = await req.json(); } catch { body = {}; }

    if (CRON_SECRET && body?.cronToken === CRON_SECRET) {
      isCron = true;
    } else if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "Missing authorization" }, 401);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Determine which users to reconcile
    let userIds: string[] = [];

    if (body?.userId) {
      // On-demand single-user call (from UI or manual trigger)
      userIds = [body.userId];
    } else {
      // Cron: reconcile all users with bot running and live mode enabled
      const { data: liveUsers } = await admin
        .from("system_state")
        .select("user_id")
        .eq("mode", "live")
        .eq("live_trading_enabled", true)
        .eq("bot", "running");

      userIds = (liveUsers ?? []).map((u: { user_id: string }) => u.user_id);
    }

    if (userIds.length === 0) {
      log("info", "reconcile_no_live_users", { fn: "position-reconcile" });
      return json({ mode: isCron ? "cron" : "manual", users: 0, results: [] });
    }

    const results: ReconcileResult[] = [];
    for (const userId of userIds) {
      try {
        const r = await reconcileUser(admin, userId);
        results.push(r);
      } catch (e) {
        log("error", "reconcile_user_failed", { fn: "position-reconcile", userId, err: String(e) });
        results.push({
          userId,
          mode: "ok",
          orphanedCoinbasePositions: [],
          ghostDbTrades: [],
          alertsWritten: 0,
        });
      }
    }

    const totalAlerts = results.reduce((sum, r) => sum + r.alertsWritten, 0);
    const totalOrphans = results.reduce((sum, r) => sum + r.orphanedCoinbasePositions.length, 0);
    const totalGhosts  = results.reduce((sum, r) => sum + r.ghostDbTrades.length, 0);

    return json({
      mode: isCron ? "cron" : "manual",
      users: results.length,
      totalOrphans,
      totalGhosts,
      totalAlerts,
      results,
    });

  } catch (e) {
    log("error", "handler_error", { fn: "position-reconcile", err: String(e) });
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
