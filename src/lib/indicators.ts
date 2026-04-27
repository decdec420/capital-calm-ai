// indicators.ts — shared EMA / RSI utilities for browser-side backtest code.
// Edge functions use the copies exported from supabase/functions/_shared/regime.ts.
// Implementations copied verbatim from src/lib/backtest.ts (the canonical
// browser-side source). The three browser/edge backtest duplicates were
// byte-identical — regime.ts's `rsi` is a different shape (returns a scalar)
// and is intentionally NOT mirrored here.

/**
 * Exponential Moving Average. Returns an array the same length as `values`,
 * seeded with the first value.
 */
export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/**
 * Wilder-smoothed RSI. Returns an array the same length as `values`; entries
 * before `period` are 50 (neutral) since there isn't enough history yet.
 */
export function rsi(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(50);
  if (values.length < period + 1) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  let avgG = gains / period;
  let avgL = losses / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}
