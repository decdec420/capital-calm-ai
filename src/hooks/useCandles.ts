import { useEffect, useRef, useState } from "react";
import type { Candle } from "@/lib/domain-types";

// Coinbase public candle endpoint. Granularity in seconds.
// Returns: [time, low, high, open, close, volume]
type CoinbaseCandle = [number, number, number, number, number, number];

interface UseCandlesResult {
  candles: Candle[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useCandles(symbol = "BTC-USD", granularity = 3600, pollMs = 30_000): UseCandlesResult {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tick = useRef(0);

  const fetchOnce = async () => {
    try {
      const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${granularity}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Coinbase ${res.status}`);
      const raw = (await res.json()) as CoinbaseCandle[];
      // Coinbase returns newest-first; sort oldest-first for charting.
      const sorted = [...raw].sort((a, b) => a[0] - b[0]);
      const mapped: Candle[] = sorted.map(([t, l, h, o, c, v]) => ({ t, l, h, o, c, v }));
      setCandles(mapped);
      setError(null);
    } catch (e) {
      // P2-D: Candle call failed — fall back to the REST ticker so callers
      // that read candles[candles.length - 1]?.c never silently see 0.
      // Only inject a synthetic candle when we currently have NO candles —
      // a stale-but-real history is always better than a single ticker point.
      try {
        const tickerUrl = `https://api.exchange.coinbase.com/products/${symbol}/ticker`;
        const tickerRes = await fetch(tickerUrl);
        if (tickerRes.ok) {
          const body = await tickerRes.json();
          const price = Number(body.price);
          if (price > 0) {
            const now = Math.floor(Date.now() / 1000);
            setCandles((prev) =>
              prev.length === 0
                ? [{ t: now, o: price, h: price, l: price, c: price, v: 0 }]
                : prev,
            );
          }
        }
      } catch {
        // Ticker also failed — leave whatever we have.
      }
      setError(e instanceof Error ? e.message : "Failed to fetch candles");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    tick.current += 1;
    const myTick = tick.current;
    setLoading(true);
    fetchOnce();
    const id = setInterval(() => {
      if (myTick === tick.current) fetchOnce();
    }, pollMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, granularity, pollMs]);

  return { candles, loading, error, refetch: fetchOnce };
}
