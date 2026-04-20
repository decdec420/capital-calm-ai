import { useEffect, useRef, useState } from "react";
import type { Candle } from "@/lib/domain-types";

// Coinbase public candle endpoint. Granularity in seconds.
// Returns: [time, low, high, open, close, volume]
type CoinbaseCandle = [number, number, number, number, number, number];

interface UseMultiCandlesResult {
  data: Record<string, Candle[]>;
  loading: boolean;
  errors: Record<string, string | null>;
  refetch: () => void;
}

// Multi-symbol parallel candle fetcher. Used by the engine status views to
// show per-symbol regimes side-by-side without needing 3 separate hooks.
export function useMultiCandles(
  symbols: string[],
  granularity = 3600,
  pollMs = 30_000,
): UseMultiCandlesResult {
  const [data, setData] = useState<Record<string, Candle[]>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const tick = useRef(0);
  const symbolsKey = symbols.join(",");

  const fetchAll = async () => {
    const results = await Promise.allSettled(
      symbols.map(async (symbol) => {
        const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${granularity}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Coinbase ${symbol} ${res.status}`);
        const raw = (await res.json()) as CoinbaseCandle[];
        const sorted = [...raw].sort((a, b) => a[0] - b[0]);
        const mapped: Candle[] = sorted.map(([t, l, h, o, c, v]) => ({ t, l, h, o, c, v }));
        return [symbol, mapped] as const;
      }),
    );
    const nextData: Record<string, Candle[]> = {};
    const nextErrors: Record<string, string | null> = {};
    results.forEach((r, i) => {
      const sym = symbols[i];
      if (r.status === "fulfilled") {
        nextData[sym] = r.value[1];
        nextErrors[sym] = null;
      } else {
        nextData[sym] = [];
        nextErrors[sym] = r.reason instanceof Error ? r.reason.message : "fetch failed";
      }
    });
    setData(nextData);
    setErrors(nextErrors);
    setLoading(false);
  };

  useEffect(() => {
    tick.current += 1;
    const myTick = tick.current;
    setLoading(true);
    fetchAll();
    const id = setInterval(() => {
      if (myTick === tick.current) fetchAll();
    }, pollMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolsKey, granularity, pollMs]);

  return { data, loading, errors, refetch: fetchAll };
}
