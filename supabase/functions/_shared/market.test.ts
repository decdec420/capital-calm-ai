// Tests for _shared/market.ts:
//   - aggregateTo4h: UTC alignment, OHLCV math, partial-bucket drop
//   - MarketHealthTracker: scope-isolated success/failure resets
//   - fetchCandles: rejects unsupported granularity (no Coinbase round-trip)

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  aggregateTo4h,
  fetchCandles,
  MarketHealthTracker,
  type Candle,
} from "./market.ts";

// ─── aggregateTo4h ─────────────────────────────────────────────────

Deno.test("aggregateTo4h — empty input", () => {
  assertEquals(aggregateTo4h([]), []);
});

Deno.test("aggregateTo4h — 4 aligned 1h candles produce one 4h candle with correct OHLCV", () => {
  // 2024-01-01 04:00 UTC = 1704081600 (multiple of 14400)
  const t0 = 1704081600;
  const ones: Candle[] = [
    { t: t0,        o: 100, h: 110, l: 95,  c: 105, v: 1 },
    { t: t0 + 3600, o: 105, h: 120, l: 100, c: 115, v: 2 },
    { t: t0 + 7200, o: 115, h: 118, l: 90,  c: 92,  v: 3 },
    { t: t0 + 10800,o: 92,  h: 99,  l: 85,  c: 97,  v: 4 },
  ];
  const out = aggregateTo4h(ones);
  assertEquals(out.length, 1);
  const c = out[0];
  assertEquals(c.t, t0);
  assertEquals(c.o, 100);          // first open
  assertEquals(c.c, 97);           // last close
  assertEquals(c.h, 120);          // max high
  assertEquals(c.l, 85);           // min low
  assertEquals(c.v, 10);           // sum volume
});

Deno.test("aggregateTo4h — buckets always align to UTC 4h boundaries (t % 14400 === 0)", () => {
  // Start at 03:00 (NOT a 4h boundary). The 03:00 candle belongs to the
  // 00:00 bucket (which is incomplete and dropped). The 04:00–07:00
  // candles form the 04:00 bucket.
  const tMisaligned = 1704078000; // 2024-01-01 03:00 UTC
  const t04 = 1704081600;         // 2024-01-01 04:00 UTC
  const ones: Candle[] = [
    { t: tMisaligned, o: 1, h: 1, l: 1, c: 1, v: 1 }, // belongs to 00:00 bucket → dropped
    { t: t04,         o: 2, h: 2, l: 2, c: 2, v: 1 },
    { t: t04 + 3600,  o: 3, h: 3, l: 3, c: 3, v: 1 },
    { t: t04 + 7200,  o: 4, h: 4, l: 4, c: 4, v: 1 },
    { t: t04 + 10800, o: 5, h: 5, l: 5, c: 5, v: 1 },
  ];
  const out = aggregateTo4h(ones);
  assertEquals(out.length, 1);
  assertEquals(out[0].t, t04);
  assertEquals(out[0].t % 14400, 0);
  assertEquals(out[0].o, 2);
  assertEquals(out[0].c, 5);
});

Deno.test("aggregateTo4h — drops trailing partial bucket with fewer than 4 candles", () => {
  const t0 = 1704081600;
  const ones: Candle[] = [
    // Complete bucket
    { t: t0,         o: 1, h: 1, l: 1, c: 1, v: 1 },
    { t: t0 + 3600,  o: 1, h: 1, l: 1, c: 1, v: 1 },
    { t: t0 + 7200,  o: 1, h: 1, l: 1, c: 1, v: 1 },
    { t: t0 + 10800, o: 1, h: 1, l: 1, c: 1, v: 1 },
    // Next bucket: only 2 candles → dropped
    { t: t0 + 14400, o: 2, h: 2, l: 2, c: 2, v: 1 },
    { t: t0 + 18000, o: 2, h: 2, l: 2, c: 2, v: 1 },
  ];
  const out = aggregateTo4h(ones);
  assertEquals(out.length, 1);
  assertEquals(out[0].t, t0);
});

Deno.test("aggregateTo4h — handles unsorted input", () => {
  const t0 = 1704081600;
  const ones: Candle[] = [
    { t: t0 + 7200,  o: 3, h: 3, l: 1, c: 3, v: 1 },
    { t: t0,         o: 1, h: 5, l: 1, c: 1, v: 1 },
    { t: t0 + 10800, o: 4, h: 4, l: 1, c: 9, v: 1 },
    { t: t0 + 3600,  o: 2, h: 2, l: 1, c: 2, v: 1 },
  ];
  const out = aggregateTo4h(ones);
  assertEquals(out.length, 1);
  assertEquals(out[0].o, 1);
  assertEquals(out[0].c, 9);
  assertEquals(out[0].h, 5);
  assertEquals(out[0].l, 1);
});

// ─── MarketHealthTracker ───────────────────────────────────────────

Deno.test("tracker — same-scope success clears prior failure", () => {
  const t = new MarketHealthTracker();
  t.recordFailure(
    { provider: "coinbase", operation: "candles", symbol: "BTC-USD", timeframe: "4h" },
    "HTTP 400",
  );
  assertEquals(t.failureCount(), 1);
  t.recordSuccess({ provider: "coinbase", operation: "candles", symbol: "BTC-USD", timeframe: "4h" });
  assertEquals(t.failureCount(), 0);
});

Deno.test("tracker — different-symbol success does NOT clear failure", () => {
  const t = new MarketHealthTracker();
  t.recordFailure(
    { provider: "coinbase", operation: "candles", symbol: "BTC-USD", timeframe: "4h" },
    "HTTP 400",
  );
  t.recordSuccess({ provider: "coinbase", operation: "candles", symbol: "ETH-USD", timeframe: "4h" });
  assertEquals(t.failureCount(), 1);
  assert(t.hasFailures());
});

Deno.test("tracker — different-timeframe success does NOT clear failure", () => {
  const t = new MarketHealthTracker();
  t.recordFailure(
    { provider: "coinbase", operation: "candles", symbol: "BTC-USD", timeframe: "4h" },
    "HTTP 400",
  );
  t.recordSuccess({ provider: "coinbase", operation: "candles", symbol: "BTC-USD", timeframe: "1h" });
  assertEquals(t.failureCount(), 1);
});

Deno.test("tracker — different-operation success does NOT clear failure", () => {
  const t = new MarketHealthTracker();
  t.recordFailure(
    { provider: "coinbase", operation: "candles", symbol: "BTC-USD", timeframe: "4h" },
    "HTTP 400",
  );
  t.recordSuccess({ provider: "coinbase", operation: "ticker", symbol: "BTC-USD", timeframe: "ticker" });
  assertEquals(t.failureCount(), 1);
});

Deno.test("tracker — summary includes provider/operation/symbol/timeframe and message", () => {
  const t = new MarketHealthTracker();
  t.recordFailure(
    { provider: "coinbase", operation: "candles", symbol: "BTC-USD", timeframe: "4h" },
    "HTTP 400",
  );
  const s = t.summary()!;
  assertStringIncludes(s, "coinbase");
  assertStringIncludes(s, "candles");
  assertStringIncludes(s, "BTC-USD");
  assertStringIncludes(s, "4h");
  assertStringIncludes(s, "HTTP 400");
});

Deno.test("tracker — summary returns null when no failures", () => {
  const t = new MarketHealthTracker();
  assertEquals(t.summary(), null);
});

Deno.test("tracker — flushHealth writes 'failed' when ≥3 failures, 'degraded' when 1–2, 'healthy' when 0", async () => {
  // Mock minimal supabase admin.
  const upserts: Array<Record<string, unknown>> = [];
  const fakeAdmin = {
    from(_table: string) {
      return {
        // deno-lint-ignore no-explicit-any
        upsert(row: any, _opts: any) {
          upserts.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  const t1 = new MarketHealthTracker();
  await t1.flushHealth(fakeAdmin, "user-a");
  assertEquals(upserts[0].status, "healthy");
  assertEquals(upserts[0].failure_count, 0);

  const t2 = new MarketHealthTracker();
  t2.recordFailure(
    { provider: "coinbase", operation: "candles", symbol: "BTC-USD", timeframe: "4h" },
    "HTTP 400",
  );
  await t2.flushHealth(fakeAdmin, "user-a");
  assertEquals(upserts[1].status, "degraded");
  assertEquals(upserts[1].failure_count, 1);

  const t3 = new MarketHealthTracker();
  for (const sym of ["BTC-USD", "ETH-USD", "SOL-USD"] as const) {
    t3.recordFailure(
      { provider: "coinbase", operation: "candles", symbol: sym, timeframe: "4h" },
      "HTTP 400",
    );
  }
  await t3.flushHealth(fakeAdmin, "user-a");
  assertEquals(upserts[2].status, "failed");
  assertEquals(upserts[2].failure_count, 3);
});

// ─── fetchCandles guard ────────────────────────────────────────────

Deno.test("fetchCandles — rejects 14400 (4h) without hitting network", async () => {
  await assertRejects(
    () => fetchCandles("BTC-USD", 14400),
    Error,
    "does not support granularity=14400",
  );
});

Deno.test("fetchCandles — rejects non-whitelisted symbol", async () => {
  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => fetchCandles("DOGE-USD" as any, 3600),
    Error,
    "non-whitelisted",
  );
});
