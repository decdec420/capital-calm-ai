// ============================================================
// Pattern Memory — Real closed-trade rollups
// ------------------------------------------------------------
// Authoritative. Browser reads from this; never forks.
// Backed by the `closed_trades_rollup` view created in the
// 20260421060000_diamond_tier_truth_pass.sql migration.
//
// The legacy signal-engine built this in-memory from the most
// recent 50 trades. That's still useful per-regime, but we
// also expose the per-symbol rollup so the AI can see it
// alongside regime slices in the same context packet.
// ============================================================

export interface SymbolRollup {
  symbol: string;
  tradeCount: number;
  wins: number;
  losses: number;
  avgPnl: number;
  netPnl: number;
  winRate: number;
}

export interface RegimeSlice {
  wins: number;
  losses: number;
  netPnl: number;
}

export interface PatternMemory {
  /** Total closed trades scanned for regime slicing (up to last 50). */
  totalClosed: number;
  /** Per-symbol rollup from the closed_trades_rollup view. */
  bySymbol: Record<string, SymbolRollup>;
  /** Per-regime slice derived from reason_tags on each closed trade. */
  byRegime: Record<string, RegimeSlice>;
}

const REGIME_TAGS = new Set([
  "trending_up",
  "trending_down",
  "breakout",
  "range",
  "chop",
]);

/**
 * Build pattern memory for a given user.
 * Uses:
 *   - `closed_trades_rollup` view (per-symbol aggregates)
 *   - last 50 closed `trades` rows (for regime slicing via reason_tags)
 */
export async function buildPatternMemory(
  // deno-lint-ignore no-explicit-any
  admin: any,
  userId: string,
): Promise<PatternMemory> {
  const [{ data: rollup }, { data: closed }] = await Promise.all([
    admin
      .from("closed_trades_rollup")
      .select("*")
      .eq("user_id", userId),
    admin
      .from("trades")
      .select("symbol,side,outcome,pnl,reason_tags")
      .eq("user_id", userId)
      .eq("status", "closed")
      .order("closed_at", { ascending: false })
      .limit(50),
  ]);

  const bySymbol: Record<string, SymbolRollup> = {};
  for (const row of rollup ?? []) {
    bySymbol[row.symbol] = {
      symbol: row.symbol,
      tradeCount: Number(row.trade_count ?? 0),
      wins: Number(row.wins ?? 0),
      losses: Number(row.losses ?? 0),
      avgPnl: Number(row.avg_pnl ?? 0),
      netPnl: Number(row.net_pnl ?? 0),
      winRate: Number(row.win_rate ?? 0),
    };
  }

  const byRegime: Record<string, RegimeSlice> = {};
  const tradeRows = closed ?? [];
  for (const t of tradeRows) {
    const pnl = Number(t.pnl ?? 0);
    const win = t.outcome === "win" || pnl > 0;
    const tags: string[] = Array.isArray(t.reason_tags) ? t.reason_tags : [];
    const regimeTag = tags.find((tag) => REGIME_TAGS.has(tag));
    if (regimeTag) {
      byRegime[regimeTag] ??= { wins: 0, losses: 0, netPnl: 0 };
      byRegime[regimeTag].wins += win ? 1 : 0;
      byRegime[regimeTag].losses += win ? 0 : 1;
      byRegime[regimeTag].netPnl += pnl;
    }
  }

  return {
    totalClosed: tradeRows.length,
    bySymbol,
    byRegime,
  };
}
