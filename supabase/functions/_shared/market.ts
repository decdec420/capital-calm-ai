// ============================================================
// Market data (Coinbase) — server-authoritative.
// ------------------------------------------------------------
// Authoritative. Browser reads from this; never forks.
// Candles / ticker / last-trade fetches for the three symbols
// on the doctrine whitelist. Used by signal-engine,
// mark-to-market, and trade-close.
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

export async function fetchCandles(
  symbol: Symbol,
  granularitySeconds = 3600,
): Promise<Candle[]> {
  if (!isWhitelistedSymbol(symbol)) {
    throw new Error(`Refusing to fetch candles for non-whitelisted symbol: ${symbol}`);
  }
  const r = await fetch(
    `${CB}/products/${symbol}/candles?granularity=${granularitySeconds}`,
  );
  if (!r.ok) throw new Error(`Coinbase ${symbol} candles ${r.status}`);
  const raw = (await r.json()) as number[][];
  // Coinbase returns [ time, low, high, open, close, volume ] newest-first.
  // Sort ascending and remap to named fields.
  return [...raw]
    .sort((a, b) => a[0] - b[0])
    .map(([t, l, h, o, c, v]) => ({ t, l, h, o, c, v }));
}

export async function fetchTicker(symbol: Symbol): Promise<Ticker> {
  if (!isWhitelistedSymbol(symbol)) {
    throw new Error(`Refusing to fetch ticker for non-whitelisted symbol: ${symbol}`);
  }
  const r = await fetch(`${CB}/products/${symbol}/ticker`);
  if (!r.ok) throw new Error(`Coinbase ${symbol} ticker ${r.status}`);
  const body = await r.json();
  return {
    symbol,
    price: Number(body.price),
    bid: body.bid != null ? Number(body.bid) : null,
    ask: body.ask != null ? Number(body.ask) : null,
    time: body.time ?? new Date().toISOString(),
  };
}

/**
 * Fetch tickers for multiple symbols in parallel.
 * Resolves with a record; failed symbols are absent from the result.
 */
export async function fetchTickers(
  symbols: Symbol[],
): Promise<Partial<Record<Symbol, Ticker>>> {
  const out: Partial<Record<Symbol, Ticker>> = {};
  const results = await Promise.allSettled(symbols.map((s) => fetchTicker(s)));
  symbols.forEach((sym, i) => {
    const r = results[i];
    if (r.status === "fulfilled") out[sym] = r.value;
  });
  return out;
}
