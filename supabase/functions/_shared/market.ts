// ============================================================
// Market data (Coinbase) — server-authoritative.
// ------------------------------------------------------------
// Authoritative. Browser reads from this; never forks.
// Candles / ticker / last-trade fetches for the three symbols
// on the doctrine whitelist. Used by signal-engine,
// mark-to-market, and trade-close.
//
// IMPORTANT: Coinbase Exchange's public /candles endpoint only
// supports these granularities (seconds):
//   60, 300, 900, 3600, 21600, 86400
// 14400 (4h) is NOT a valid Coinbase granularity. fetchCandles4h
// therefore fetches 1h candles and aggregates them locally into
// UTC-aligned 4h OHLCV buckets. See fetchCandles4h() below.
// ============================================================

import { SYMBOL_WHITELIST, isWhitelistedSymbol } from "./doctrine.ts";

export type Symbol = (typeof SYMBOL_WHITELIST)[number];

export interface Candle {
  t: number; // unix seconds (candle start)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Ticker {
  symbol: Symbol;
  price: number;
  bid: number | null;
  ask: number | null;
  time: string;
}

const CB = "https://api.exchange.coinbase.com";
const COINBASE_VALID_GRANULARITIES = new Set([60, 300, 900, 3600, 21600, 86400]);

/**
 * Exponential backoff sleep. Deno-compatible.
 * Waits `ms` milliseconds, with up to ±20% jitter so concurrent callers
 * don't all retry at exactly the same moment.
 */
function sleep(ms: number): Promise<void> {
  const jitter = ms * 0.2 * (Math.random() * 2 - 1); // ±20%
  return new Promise((resolve) => setTimeout(resolve, ms + jitter));
}

// ─── Health-tracking context ───────────────────────────────────────
// _shared/market.ts stays caller-agnostic. Callers that want failures
// reflected in agent_health pass a tracker; callers that don't (tests,
// ad-hoc) skip it and fetches behave normally.

export interface MarketFetchContext {
  tracker?: MarketHealthTracker;
}

interface FetchKey {
  provider: string;     // e.g. "coinbase"
  operation: string;    // e.g. "candles" | "ticker"
  symbol: string;       // e.g. "BTC-USD"
  timeframe: string;    // e.g. "1h" | "4h" | "ticker"
}

interface FailureRecord extends FetchKey {
  message: string;
  at: number; // ms
}

/**
 * Tracks per-(provider,op,symbol,timeframe) successes and failures across
 * a single signal-engine run. Reset failures only get cleared by a SUCCESS
 * for the SAME scope — a ticker success never clears a candle failure,
 * a 1h success never clears a 4h failure, an ETH success never clears a
 * BTC failure.
 *
 * Call flushHealth(admin, userId) once at the end of processing for each
 * user to upsert their agent_health.signal_engine row.
 */
export class MarketHealthTracker {
  private failures = new Map<string, FailureRecord>();
  private successes = new Set<string>();

  private static keyOf(k: FetchKey): string {
    return `${k.provider}|${k.operation}|${k.symbol}|${k.timeframe}`;
  }

  recordSuccess(k: FetchKey): void {
    const key = MarketHealthTracker.keyOf(k);
    this.successes.add(key);
    // Same scope success clears prior failure for that scope only.
    this.failures.delete(key);
  }

  recordFailure(k: FetchKey, message: string): void {
    const key = MarketHealthTracker.keyOf(k);
    this.failures.set(key, { ...k, message, at: Date.now() });
  }

  hasFailures(): boolean {
    return this.failures.size > 0;
  }

  failureCount(): number {
    return this.failures.size;
  }

  /** Compact one-line summary for agent_health.last_error. */
  summary(): string | null {
    if (this.failures.size === 0) return null;
    // Newest first, max 3 to keep the message compact.
    const recent = [...this.failures.values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, 3)
      .map((f) =>
        `[${f.provider} ${f.operation} ${f.symbol} ${f.timeframe}] ${f.message}`
      );
    const more = this.failures.size > 3 ? ` (+${this.failures.size - 3} more)` : "";
    return recent.join(" | ") + more;
  }

  /**
   * Upsert agent_health for signal_engine for this user.
   * Status policy:
   *   0 failures → 'healthy'
   *   1–2 failures → 'degraded'
   *   ≥3 failures → 'failed'
   * Never resets failure_count to 0 unless there are zero failures.
   */
  // deno-lint-ignore no-explicit-any
  async flushHealth(admin: any, userId: string): Promise<void> {
    const failures = this.failureCount();
    let status: "healthy" | "degraded" | "failed";
    if (failures === 0) status = "healthy";
    else if (failures < 3) status = "degraded";
    else status = "failed";

    const nowIso = new Date().toISOString();
    const row: Record<string, unknown> = {
      user_id: userId,
      agent_name: "signal_engine",
      status,
      failure_count: failures,
      last_error: this.summary(),
      checked_at: nowIso,
    };
    if (status === "healthy") row.last_success = nowIso;
    else row.last_failure = nowIso;

    try {
      await admin
        .from("agent_health")
        .upsert(row, { onConflict: "user_id,agent_name" });
    } catch (e) {
      console.error(
        `[market] failed to flush agent_health for user ${userId}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}

// ─── Public fetchers ───────────────────────────────────────────────

/**
 * Fetch 1-minute candles. Used by mark-to-market so TP1/TP2 fire when
 * the recent bar high/low actually tagged the level — not only when the
 * current spot tick is sitting beyond it. Mirrors the realism of the
 * stop path, which has always used the bar low.
 */
export async function fetchCandles1m(
  symbol: Symbol,
  ctx: MarketFetchContext = {},
): Promise<Candle[]> {
  return fetchCandles(symbol, 60, ctx, "1m");
}

/**
 * Fetch 15-minute candles for entry timing.
 * Used by the signal engine to confirm whether the 1h setup is right
 * NOW (15m momentum cooperating) or whether to wait for a better tick.
 */
export async function fetchCandles15m(
  symbol: Symbol,
  ctx: MarketFetchContext = {},
): Promise<Candle[]> {
  return fetchCandles(symbol, 900, ctx);
}

/**
 * Fetch 4-hour candles for multi-timeframe context.
 *
 * Coinbase does not support a native 4h granularity (valid: 60, 300, 900,
 * 3600, 21600, 86400). We fetch 1h candles and aggregate locally into
 * UTC-aligned 4h OHLCV buckets (00:00, 04:00, 08:00, 12:00, 16:00, 20:00).
 *
 * Coinbase returns up to 300 candles per request → ~75 completed 4h
 * candles, which is plenty for the current Technical Analyst (uses ~10).
 * If a future indicator needs deeper 4h history (e.g. EMA-200 ≈ 33 days
 * of 1h data), add pagination via the `start`/`end` query params.
 */
export async function fetchCandles4h(
  symbol: Symbol,
  ctx: MarketFetchContext = {},
): Promise<Candle[]> {
  const oneHour = await fetchCandles(symbol, 3600, ctx, "4h");
  return aggregateTo4h(oneHour);
}

/**
 * Aggregate 1h candles into UTC-aligned 4h buckets.
 * Exported for testing.
 *
 *  - open   = first 1h open in the bucket
 *  - close  = last 1h close in the bucket
 *  - high   = max high
 *  - low    = min low
 *  - volume = sum volume
 *  - t      = bucket start (timestamp where t % 14400 === 0)
 *
 * Buckets with fewer than 4 completed 1h candles are dropped so the
 * analyst never sees a half-formed 4h candle.
 */
export function aggregateTo4h(oneHour: Candle[]): Candle[] {
  if (oneHour.length === 0) return [];
  // Defensive: ensure ascending order by timestamp.
  const sorted = [...oneHour].sort((a, b) => a.t - b.t);

  const buckets = new Map<number, Candle[]>();
  for (const c of sorted) {
    const bucketStart = Math.floor(c.t / 14400) * 14400;
    let arr = buckets.get(bucketStart);
    if (!arr) {
      arr = [];
      buckets.set(bucketStart, arr);
    }
    arr.push(c);
  }

  const out: Candle[] = [];
  for (const [bucketStart, members] of [...buckets.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    if (members.length < 4) continue; // drop incomplete buckets
    const open = members[0].o;
    const close = members[members.length - 1].c;
    let high = -Infinity;
    let low = Infinity;
    let vol = 0;
    for (const m of members) {
      if (m.h > high) high = m.h;
      if (m.l < low) low = m.l;
      vol += m.v;
    }
    out.push({ t: bucketStart, o: open, h: high, l: low, c: close, v: vol });
  }
  return out;
}

/**
 * Low-level Coinbase candle fetch. Use fetchCandles4h() for 4h — calling
 * fetchCandles() with granularity=14400 will throw immediately rather than
 * hitting Coinbase and getting an opaque 400.
 *
 * `timeframeLabel` is for health reporting only; it defaults to a derived
 * label from the granularity. Pass "4h" when this is the underlying call
 * for a 4h aggregation so failures surface as "4h" in agent_health.
 */
export async function fetchCandles(
  symbol: Symbol,
  granularitySeconds = 3600,
  ctx: MarketFetchContext = {},
  timeframeLabel?: string,
): Promise<Candle[]> {
  if (!isWhitelistedSymbol(symbol)) {
    throw new Error(`Refusing to fetch candles for non-whitelisted symbol: ${symbol}`);
  }
  if (!COINBASE_VALID_GRANULARITIES.has(granularitySeconds)) {
    throw new Error(
      `Coinbase does not support granularity=${granularitySeconds}. ` +
        `Valid values: ${[...COINBASE_VALID_GRANULARITIES].join(", ")}. ` +
        `For 4h candles use fetchCandles4h(), which aggregates 1h locally.`,
    );
  }

  const tf = timeframeLabel ?? labelForGranularity(granularitySeconds);
  const key: FetchKey = {
    provider: "coinbase",
    operation: "candles",
    symbol,
    timeframe: tf,
  };

  // Exponential backoff retry — up to 3 attempts with ~1s, ~2s, ~4s waits.
  // Retries on 429 (rate-limit), 5xx (server errors), and network failures.
  // Non-retryable errors (4xx except 429) surface immediately.
  const MAX_ATTEMPTS = 3;
  const url = `${CB}/products/${symbol}/candles?granularity=${granularitySeconds}`;
  let lastError: Error = new Error("unreachable");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
      console.warn(
        `[market] Coinbase candle retry ${attempt}/${MAX_ATTEMPTS - 1} for ${symbol} ${tf} in ~${backoffMs}ms`,
      );
      await sleep(backoffMs);
    }
    try {
      const r = await fetch(url);
      if (r.status === 429 || r.status >= 500) {
        lastError = new Error(`HTTP ${r.status}`);
        continue; // retryable
      }
      if (!r.ok) {
        const msg = `HTTP ${r.status}`;
        ctx.tracker?.recordFailure(key, msg);
        throw new Error(`Coinbase ${symbol} candles ${r.status}`);
      }
      const raw = (await r.json()) as number[][];
      // Coinbase returns [ time, low, high, open, close, volume ] newest-first.
      // Sort ascending and remap to named fields.
      const candles = [...raw]
        .sort((a, b) => a[0] - b[0])
        .map(([t, l, h, o, c, v]) => ({ t, l, h, o, c, v }));
      ctx.tracker?.recordSuccess(key);
      return candles;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Coinbase ")) throw e; // non-retryable 4xx
      lastError = e instanceof Error ? e : new Error(String(e));
      // Network / timeout error — retryable
    }
  }

  // All attempts exhausted
  ctx.tracker?.recordFailure(key, lastError.message);
  throw lastError;
}

function labelForGranularity(g: number): string {
  switch (g) {
    case 60:    return "1m";
    case 300:   return "5m";
    case 900:   return "15m";
    case 3600:  return "1h";
    case 21600: return "6h";
    case 86400: return "1d";
    default:    return `${g}s`;
  }
}

export async function fetchTicker(
  symbol: Symbol,
  ctx: MarketFetchContext = {},
): Promise<Ticker> {
  if (!isWhitelistedSymbol(symbol)) {
    throw new Error(`Refusing to fetch ticker for non-whitelisted symbol: ${symbol}`);
  }
  const key: FetchKey = {
    provider: "coinbase",
    operation: "ticker",
    symbol,
    timeframe: "ticker",
  };
  try {
    let r = await fetch(`${CB}/products/${symbol}/ticker`);
    if (r.status === 429) {
      console.warn(`[market] Coinbase rate-limited on ${symbol} ticker — retrying in ~1s`);
      await sleep(1000);
      r = await fetch(`${CB}/products/${symbol}/ticker`);
    }
    if (!r.ok) {
      ctx.tracker?.recordFailure(key, `HTTP ${r.status}`);
      throw new Error(`Coinbase ${symbol} ticker ${r.status}`);
    }
    const body = await r.json();
    const ticker: Ticker = {
      symbol,
      price: Number(body.price),
      bid: body.bid != null ? Number(body.bid) : null,
      ask: body.ask != null ? Number(body.ask) : null,
      time: body.time ?? new Date().toISOString(),
    };
    ctx.tracker?.recordSuccess(key);
    return ticker;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Coinbase ")) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    ctx.tracker?.recordFailure(key, msg);
    throw e;
  }
}

/**
 * Fetch tickers for multiple symbols in parallel.
 * Resolves with a record; failed symbols are absent from the result.
 */
export async function fetchTickers(
  symbols: Symbol[],
  ctx: MarketFetchContext = {},
): Promise<Partial<Record<Symbol, Ticker>>> {
  const out: Partial<Record<Symbol, Ticker>> = {};
  const results = await Promise.allSettled(symbols.map((s) => fetchTicker(s, ctx)));
  symbols.forEach((sym, i) => {
    const r = results[i];
    if (r.status === "fulfilled") out[sym] = r.value;
  });
  return out;
}
