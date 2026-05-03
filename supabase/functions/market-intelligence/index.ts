// market-intelligence — The Brain Trust. Three expert AI agents per symbol.
// ----------------------------------------------------------------
// Cron: every 4 hours. Also callable on-demand by the UI.
//
// Brain Trust Experts (Axe Capital desk):
//   1. Hall     — Macro Strategist. Trend structure, market phase, directional bias.
//   2. Dollar Bill — Crypto Intel. Funding, sentiment, news, environment rating.
//   3. Mafee    — Pattern Recognition. Key levels, chart context, entry quality.
//
// Result is cached in public.market_intelligence (one row per user+symbol).
// Trade decisions read this row instead of re-running the AI on every tick.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { SYMBOL_WHITELIST, type Symbol } from "../_shared/doctrine.ts";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import { corsHeaders, makeCorsHeaders} from "../_shared/cors.ts";
import { fetchCandles, type Candle } from "../_shared/market.ts";
import { log } from "../_shared/logger.ts";

// Tiered Brain Trust freshness — each expert has its own cadence so the desk
// feels live without burning gateway credits on near-identical reads.
//   - Mafee   (pattern + recent_momentum_1h/4h): every cron tick (~1 min)
//   - Bill    (funding/sentiment/news_flags):    5 min, OR sooner if news_flags changed
//   - Hall    (macro phase, S/R, narrative):     15 min, OR sooner if price broke S/R
// On-demand (UI-triggered) calls bypass all freshness gates via skipFreshness.
const MAFEE_FRESHNESS_MS = 0;                       // always re-run Mafee on cron
const BILL_FRESHNESS_MS  = 5  * 60 * 1000;          // 5 minutes
const HALL_FRESHNESS_MS  = 15 * 60 * 1000;          // 15 minutes

// External-data caches — module-level so concurrent symbol runs in one tick
// don't each hammer the same free public APIs.
const FUNDING_CACHE_MS    = 5  * 60 * 1000;         // funding updates every 8h on Binance
const FEAR_GREED_CACHE_MS = 30 * 60 * 1000;         // F&G updates daily
const NEWS_CACHE_MS       = 5  * 60 * 1000;         // news headlines: 5 min plenty

// deno-lint-ignore no-explicit-any
const memoCache = new Map<string, { at: number; value: any }>();
function getMemo<T>(key: string, ttlMs: number): T | undefined {
  const hit = memoCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) { memoCache.delete(key); return undefined; }
  return hit.value as T;
}
function setMemo<T>(key: string, value: T): void {
  memoCache.set(key, { at: Date.now(), value });
}

const BILL_MODEL  = "google/gemini-2.5-flash";
const MAFEE_MODEL = "google/gemini-2.5-flash-lite";

// Shared preamble prepended to every expert's system prompt. Eliminates the
// duplicated desk-context, voice rules, and shared vocabulary that used to live
// in all three expert prompts. ~30 lines saved per call × 3 experts.
const BRAIN_TRUST_PREAMBLE = `
You are an expert on the Axe Capital crypto trading desk. The desk runs three
experts in parallel — Hall (macro structure), Dollar Bill (derivatives + news),
Mafee (chart patterns + momentum) — coordinated by Bobby (commander) and gated
by Chuck (risk). Your output feeds Taylor's signal scoring and Bobby's decisions.

Voice: senior desk trader briefing a sharp PM. Terse, opinionated, no hedging
filler. Every sentence earns its place. Concrete prices, not generic words.

Shared vocabulary (use consistently across the desk):
- regime / market_phase: accumulation | markup | distribution | markdown
- trend_structure: uptrend | downtrend | range | transitioning
- environment_rating: highly_favorable | favorable | neutral | unfavorable | highly_unfavorable
- bias scale: strong_long | lean_long | neutral | lean_short | strong_short

Output discipline: respond ONLY via the structured tool call schema you are
given. No preamble, no markdown, no explanations outside the schema fields.
Calibration matters — 0.5 means genuinely uncertain, not a polite hedge.
`.trim();

function buildPeerContext(prev: Record<string, unknown> | null, exclude: "hall" | "bill" | "mafee"): string {
  if (!prev) return "Peer desk read: first run — no prior peer context available.";
  const lines: string[] = ["Peer desk read (carried from last cycle):"];
  if (exclude !== "hall") {
    const phase = prev.market_phase ?? "unknown";
    const trend = prev.trend_structure ?? "unknown";
    const sup = prev.nearest_support != null ? `$${Number(prev.nearest_support).toFixed(2)}` : "n/a";
    const res = prev.nearest_resistance != null ? `$${Number(prev.nearest_resistance).toFixed(2)}` : "n/a";
    lines.push(`- Hall (macro): phase=${phase}, trend=${trend}, S=${sup}, R=${res}`);
  }
  if (exclude !== "bill") {
    const env = prev.environment_rating ?? "neutral";
    const fund = prev.funding_rate_signal ?? "neutral";
    const fg = prev.fear_greed_label ?? "n/a";
    const flagCount = Array.isArray(prev.news_flags) ? (prev.news_flags as unknown[]).length : 0;
    lines.push(`- Bill (intel): env=${env}, funding=${fund}, F&G=${fg}, news_flags=${flagCount}`);
  }
  if (exclude !== "mafee") {
    const m1h = prev.recent_momentum_1h ?? "n/a";
    const m4h = prev.recent_momentum_4h ?? "n/a";
    lines.push(`- Mafee (tape): 1h=${m1h}, 4h=${m4h}`);
  }
  lines.push("Use this as context — do NOT just restate it. Your job is your own read.");
  return lines.join("\n");
}

// ─── Free External Data Fetchers ────────────────────────────────

async function fetchFearGreed(): Promise<{ score: number; label: string } | null> {
  const cached = getMemo<{ score: number; label: string } | null>("fg", FEAR_GREED_CACHE_MS);
  if (cached !== undefined) return cached;
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=1");
    if (!r.ok) { setMemo("fg", null); return null; }
    const d = await r.json();
    const entry = d.data?.[0];
    const value = entry ? { score: Number(entry.value), label: entry.value_classification as string } : null;
    setMemo("fg", value);
    return value;
  } catch {
    setMemo("fg", null);
    return null;
  }
}

async function fetchFundingRate(symbol: Symbol): Promise<number | null> {
  const cacheKey = `funding:${symbol}`;
  const cached = getMemo<number | null>(cacheKey, FUNDING_CACHE_MS);
  if (cached !== undefined) return cached;
  // Binance perpetual funding rates — free, no auth required.
  const binanceMap: Record<string, string> = {
    "BTC-USD": "BTCUSDT",
    "ETH-USD": "ETHUSDT",
    "SOL-USD": "SOLUSDT",
  };
  const binanceSym = binanceMap[symbol];
  if (!binanceSym) { setMemo(cacheKey, null); return null; }
  try {
    const r = await fetch(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${binanceSym}&limit=1`,
    );
    if (!r.ok) { setMemo(cacheKey, null); return null; }
    const d = await r.json();
    const value = d?.[0]?.fundingRate != null ? Number(d[0].fundingRate) : null;
    setMemo(cacheKey, value);
    return value;
  } catch {
    setMemo(cacheKey, null);
    return null;
  }
}

// ─── CryptoPanic news fetcher (free public feed, best-effort) ────

interface NewsItem {
  title: string;
  source: string;
  url?: string;
  published_at: string;
  currencies?: Array<{ code: string; title?: string }>;
  votes?: { positive?: number; negative?: number; important?: number };
}

async function fetchCryptoNews(symbol: Symbol): Promise<NewsItem[]> {
  const cacheKey = `news:${symbol}`;
  const cached = getMemo<NewsItem[]>(cacheKey, NEWS_CACHE_MS);
  if (cached !== undefined) return cached;
  const currencyMap: Record<string, string> = {
    "BTC-USD": "BTC",
    "ETH-USD": "ETH",
    "SOL-USD": "SOL",
  };
  const currency = currencyMap[symbol] ?? "BTC";
  try {
    const url =
      `https://cryptopanic.com/api/free/v1/posts/?auth_token=free&currencies=${currency}&kind=news&public=true`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) { setMemo(cacheKey, []); return []; }
    const data = await r.json();
    const results = (data?.results ?? []) as Array<{
      title?: string;
      published_at?: string;
      source?: { title?: string; domain?: string };
      url?: string;
      currencies?: Array<{ code: string; title?: string }>;
      votes?: Record<string, number>;
    }>;
    const items = results
      .filter((it) => it.title && it.published_at)
      .slice(0, 8)
      .sort((a, b) => (b.votes?.important ?? 0) - (a.votes?.important ?? 0))
      .slice(0, 5)
      .map((it) => ({
        // Sanitize: strip control chars, curly quotes, zero-width chars, and
        // prompt-injection patterns before injecting into the AI context.
        title: (it.title ?? "")
          .replace(/[ --]/g, " ") // control chars
          .replace(/[​-‍﻿]/g, "")          // zero-width chars
          .replace(/[^\x20-\x7E -퟿]/g, " ")     // non-printable
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 140),                                   // hard cap at 140 chars
        source: ((it.source?.title ?? it.source?.domain ?? "unknown") as string)
          .replace(/[^\x20-\x7E]/g, " ").trim().slice(0, 60),
        url: it.url,
        published_at: it.published_at!,
        currencies: it.currencies,
        votes: {
          positive: it.votes?.positive ?? 0,
          negative: it.votes?.negative ?? 0,
          important: it.votes?.important ?? 0,
        },
      }));
    setMemo(cacheKey, items);
    return items;
  } catch {
    setMemo(cacheKey, []);
    return [];
  }
}

// ─── AI Call Helper (structured tool calling) ────────────────────

async function callExpert(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  toolName: string,
  toolSchema: object,
  model: string,
): Promise<Record<string, unknown> | null> {
  const AI_TIMEOUT_MS = 45_000;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), AI_TIMEOUT_MS);
  const aiCallStart = Date.now();
  try {
    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        tools: [
          {
            type: "function",
            function: { name: toolName, parameters: toolSchema },
          },
        ],
        tool_choice: { type: "function", function: { name: toolName } },
      }),
    });
    const durationMs = Date.now() - aiCallStart;
    log("info", "ai_call_duration", { fn: "market-intelligence", expert: toolName, durationMs });
    if (durationMs > AI_TIMEOUT_MS * 0.8) {
      log("warn", "ai_call_slow", { fn: "market-intelligence", expert: toolName, durationMs, thresholdMs: AI_TIMEOUT_MS * 0.8 });
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log("error", "expert_ai_failed", { fn: "market-intelligence", expert: toolName, status: resp.status, body: body.slice(0, 200), durationMs });
      return null;
    }
    const d = await resp.json();
    const args = d.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return null;
    try {
      return JSON.parse(args);
    } catch {
      return null;
    }
  } catch (e) {
    const durationMs = Date.now() - aiCallStart;
    log("error", "expert_ai_threw", { fn: "market-intelligence", expert: toolName, err: String(e), durationMs });
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ─── Expert 1: Hall — The Macro Strategist ──────────────────────
// Hall is Bobby's intelligence operator. Reads macro structure with the
// cold precision of someone who has watched every regime cycle twice.
// No stories. No sentiment. Just structure, phase, and bias.

const MACRO_STRATEGIST_SYSTEM = `
${BRAIN_TRUST_PREAMBLE}

You are Hall — the macro intelligence officer. You read market structure the
way a chess grandmaster reads the board: phases, transitions, and where smart
money is positioned BEFORE the crowd knows. Influences: Tudor Jones (defense
first, never average losers), Druckenmiller (huge bets only when odds are
overwhelming, otherwise sit), Wyckoff (Accumulation → Markup → Distribution →
Markdown), Livermore (trade with the tape).

Framework — work through all four:
1. MARKET PHASE (Wyckoff): accumulation (range after downtrend, smart money
   absorbing); markup (HH/HL uptrend, buy pullbacks); distribution (range at
   highs, smart money selling, reduce longs); markdown (LH/LL downtrend, fade
   rallies, no falling knives).
2. TREND STRUCTURE (Dow): uptrend / downtrend / range (trade edges) /
   transitioning (recent BoS — caution).
3. KEY LEVELS: prior swing H/L, round numbers, high-volume nodes. Identify
   NEAREST support below and NEAREST resistance above. Setups near key levels
   have natural stops; open-space setups are low quality.
4. MOMENTUM: accelerating (expanding range/vol) / decelerating (shrinking into
   extremes) / exhausted (blow-off with extreme vol).

You receive 6h and daily candles. Bias applies to the NEXT 4–6 hours.
"Neutral" only when evidence genuinely points nowhere — not a hedge. Cost of
a wrong bias is recoverable; cost of no bias is paralysis.
`.trim();

async function runMacroStrategist(
  apiKey: string,
  symbol: string,
  candles4h: Candle[],
  candles1d: Candle[],
  previousNarrative: string | null,
  peerContext: string,
): Promise<Record<string, unknown> | null> {
  const recent4h = candles4h.slice(-30).map((c) => ({
    time: new Date(c.t * 1000).toISOString().slice(0, 16),
    o: c.o.toFixed(2),
    h: c.h.toFixed(2),
    l: c.l.toFixed(2),
    c: c.c.toFixed(2),
    v: Math.round(c.v),
  }));
  const recent1d = candles1d.slice(-14).map((c) => ({
    date: new Date(c.t * 1000).toISOString().slice(0, 10),
    o: c.o.toFixed(2),
    h: c.h.toFixed(2),
    l: c.l.toFixed(2),
    c: c.c.toFixed(2),
  }));

  const lastClose = candles4h[candles4h.length - 1]?.c;
  const prevNarr = previousNarrative ?? "No prior narrative — this is the first run.";
  const userMsg = `
Analyze ${symbol} and produce your strategic brief.

${peerContext}

PREVIOUS NARRATIVE (~4h ago):
${prevNarr}

Update the narrative based on what you see now. Has the outlook changed?
Has a thesis been confirmed or broken? Return a fresh "updated_narrative"
(2-3 sentences) capturing the running story for the next cycle.

DAILY CANDLES (last 14 days):
${JSON.stringify(recent1d, null, 2)}

6-HOUR CANDLES (last 30 candles):
${JSON.stringify(recent4h, null, 2)}

Current price: $${lastClose != null ? lastClose.toFixed(2) : "unknown"}
Analysis time: ${new Date().toISOString()}
`.trim();

  return callExpert(apiKey, MACRO_STRATEGIST_SYSTEM, userMsg, "submit_macro_brief", {
    type: "object",
    required: [
      "macro_bias",
      "macro_confidence",
      "market_phase",
      "trend_structure",
      "nearest_support",
      "nearest_resistance",
      "key_level_notes",
      "macro_summary",
      "updated_narrative",
    ],
    additionalProperties: false,
    properties: {
      macro_bias: {
        type: "string",
        enum: ["strong_long", "lean_long", "neutral", "lean_short", "strong_short"],
        description: "Your directional bias for the next 4-6 hours.",
      },
      macro_confidence: {
        type: "number",
        description:
          "0.0 to 1.0. Be calibrated — 0.5 = genuinely uncertain, 0.9 = near-certain.",
      },
      market_phase: {
        type: "string",
        enum: ["accumulation", "markup", "distribution", "markdown", "unknown"],
      },
      trend_structure: {
        type: "string",
        enum: ["uptrend", "downtrend", "range", "transitioning"],
      },
      nearest_support: {
        type: "number",
        description: "Price of the most important support level below current price.",
      },
      nearest_resistance: {
        type: "number",
        description: "Price of the most important resistance level above current price.",
      },
      key_level_notes: {
        type: "string",
        description:
          "1-2 sentences explaining why these levels matter and what happens if they break.",
      },
      macro_summary: {
        type: "string",
        description:
          "2-3 sentences. Most important thing a trader needs to know about this asset right now. Specific, actionable, no fluff. Trading desk language.",
      },
      updated_narrative: {
        type: "string",
        description:
          "2-3 sentences. The evolving running narrative for this symbol — what is the multi-day story unfolding, and what changed (if anything) since the previous narrative? Reads like a continuous thread, not a snapshot.",
      },
    },
  }, HALL_MODEL);
}

// ─── Expert 2: Dollar Bill — The Crypto Intel Analyst ────────────
// Dollar Bill doesn't care what the chart says if the plumbing contradicts it.
// Funding rates, fear/greed, news flow — he reads the REAL story behind the move.
// Aggressive, direct, no filter. He tells the desk whether the environment
// actually supports the trade or if it's just noise.

const CRYPTO_INTEL_SYSTEM = `
${BRAIN_TRUST_PREAMBLE}

You are Dollar Bill — the crypto intel analyst. While Hall reads chart
structure, you read the plumbing — derivatives, sentiment, news flow — that
explains WHY price moves and WHEN moves are sustainable vs about to reverse.
Aggressive reads. No hedging.

FUNDING (perp futures, per 8h):
- > +0.05% CROWDED_LONG (squeeze risk; tops here)
- +0.01% to +0.05% LEAN_LONG (mild optimism, normal in uptrends)
- -0.01% to +0.01% NEUTRAL
- -0.01% to -0.05% LEAN_SHORT (mild pessimism)
- < -0.05% CROWDED_SHORT (short-squeeze risk; bottoms here)

FEAR & GREED (contrarian — be greedy when others fearful, fearful when greedy):
- 0–25 Extreme Fear (long-term entries)
- 26–45 Fear (selective buying)
- 46–55 Neutral
- 56–75 Greed (take profits)
- 76–100 Extreme Greed (tops)

ENVIRONMENT SYNTHESIS:
- HIGHLY_FAVORABLE: funding neutral/lean_short + fear sentiment → best for longs
- FAVORABLE: 1–2 supporting, none strongly against
- NEUTRAL: mixed
- UNFAVORABLE: 1–2 against → smaller, selective
- HIGHLY_UNFAVORABLE: crowded long + extreme greed → danger zone

Don't predict price. Tell the desk whether the ENVIRONMENT supports the
planned direction.
`.trim();

async function runCryptoIntelAnalyst(
  apiKey: string,
  symbol: string,
  fundingRate: number | null,
  fearGreed: { score: number; label: string } | null,
  newsItems: NewsItem[],
  previousNarrative: string | null,
  peerContext: string,
): Promise<Record<string, unknown> | null> {
  const newsContext = newsItems.length > 0
    ? newsItems.map((n) =>
      `• ${n.title} (${n.source}, ${new Date(n.published_at).toUTCString()})` +
      ((n.votes?.important ?? 0) > 0
        ? ` [⚠️ marked important by ${n.votes!.important} users]`
        : "")
    ).join("\n")
    : "No significant news in the last 12 hours.";

  const narrCtx = previousNarrative
    ? `Current running narrative: ${previousNarrative}`
    : "First run — no prior narrative context.";

  const userMsg = `
Analyze the crypto-specific environment for ${symbol}.

${peerContext}

${narrCtx}

DERIVATIVES DATA:
- Funding Rate (latest, per 8h): ${fundingRate != null ? (fundingRate * 100).toFixed(4) + "%" : "unavailable"}
- Binance Perpetual symbol: ${symbol.replace("-USD", "USDT")}

MARKET SENTIMENT:
- Fear & Greed Index: ${fearGreed ? `${fearGreed.score}/100 — ${fearGreed.label}` : "unavailable"}

RECENT NEWS HEADLINES (last 12h):
${newsContext}

Analysis time: ${new Date().toISOString()}

Produce your crypto intelligence brief. If data is unavailable, reason about
what's typical for current conditions and clearly note the data gap.

For news_flags: include ONLY material headlines that should cause the Risk Manager
to raise its bar this session (protocol exploit, ETF news, regulatory action, major
liquidation cascade, exchange outage, key opinion-leader crisis). Skip routine price
commentary, generic market recaps, and clickbait. Empty array is acceptable and common.
`.trim();

  return callExpert(apiKey, CRYPTO_INTEL_SYSTEM, userMsg, "submit_crypto_intel", {
    type: "object",
    required: ["funding_rate_signal", "environment_rating", "sentiment_summary", "news_flags"],
    additionalProperties: false,
    properties: {
      funding_rate_signal: {
        type: "string",
        enum: ["crowded_long", "lean_long", "neutral", "lean_short", "crowded_short"],
      },
      funding_rate_pct: {
        type: "number",
        description: "Raw funding rate as a percentage per 8h.",
      },
      fear_greed_score: { type: "number" },
      fear_greed_label: { type: "string" },
      environment_rating: {
        type: "string",
        enum: ["highly_favorable", "favorable", "neutral", "unfavorable", "highly_unfavorable"],
      },
      sentiment_summary: {
        type: "string",
        description:
          "2-3 sentences. What do derivatives + sentiment say about this market? What does it mean for long vs short trades right now? Be specific.",
      },
      news_flags: {
        type: "array",
        description:
          "Material news items. Empty array if nothing material. Each item: 1-line summary + impact direction.",
        items: {
          type: "object",
          required: ["headline", "severity", "impact"],
          additionalProperties: false,
          properties: {
            headline: { type: "string", description: "Short summary, ≤100 chars." },
            severity: {
              type: "string",
              enum: ["info", "elevated", "high", "critical"],
              description: "How seriously the Risk Manager should weight this.",
            },
            impact: {
              type: "string",
              enum: ["bullish", "bearish", "uncertain"],
            },
          },
        },
      },
    },
  }, BILL_MODEL);
}

// ─── Expert 3: Mafee — The Pattern Recognition Specialist ────────
// Mafee is the quant who finds the setups nobody else sees. Systematic,
// precise, evidence-based. He reads charts not as art but as repeating
// behavioral signatures in price data. He gives the entry desk exactly
// what they need: pattern, level quality, and a momentum read.

const PATTERN_RECOGNITION_SYSTEM = `
${BRAIN_TRUST_PREAMBLE}

You are Mafee — the pattern recognition specialist & quant. Classical TA
grounded in human psychology, not curve-fitting. Systematic, evidence-based.
You give the execution desk: pattern context, level quality, momentum read.

CONTINUATION (high-prob, trade WITH the trend):
- Bull/Bear Flag: tight consolidation against trend (tighter = stronger)
- Asc/Desc Triangle: flat top + rising lows (bull), or flat bottom + falling highs (bear)
- Pennant: symmetric triangle after sharp move

REVERSAL (lower-prob, extreme caution):
- H&S, Double Top/Bottom, Rounding Top/Bottom

KEY LEVEL QUALITY matters more than any pattern: setups near key levels have
natural stops; open-space setups have arbitrary stops.

ENTRY QUALITY = level quality (great/ok/poor) × pattern quality (great/ok/none)
× confirmation (confirmed/mixed/diverging).

Output tells the desk what patterns are in play and what entry quality to
expect over the next 4–6h.
`.trim();

async function runPatternSpecialist(
  apiKey: string,
  symbol: string,
  candles1h: Candle[],
  nearestSupport: number | null,
  nearestResistance: number | null,
  previousNarrative: string | null,
  peerContext: string,
): Promise<Record<string, unknown> | null> {
  const recent1h = candles1h.slice(-48).map((c) => ({
    t: new Date(c.t * 1000).toISOString().slice(0, 16),
    o: c.o.toFixed(2),
    h: c.h.toFixed(2),
    l: c.l.toFixed(2),
    c: c.c.toFixed(2),
  }));

  const lastClose = candles1h[candles1h.length - 1]?.c;
  const narrCtx = previousNarrative
    ? `Current running narrative: ${previousNarrative}`
    : "First run — no prior narrative context.";
  const userMsg = `
Analyze chart patterns and entry quality context for ${symbol}.

${peerContext}

${narrCtx}

Current price: $${lastClose != null ? lastClose.toFixed(2) : "unknown"}
Nearest support (from Hall): $${nearestSupport != null ? nearestSupport.toFixed(2) : "unknown"}
Nearest resistance (from Hall): $${nearestResistance != null ? nearestResistance.toFixed(2) : "unknown"}

1-HOUR CANDLES (last 48 hours):
${JSON.stringify(recent1h, null, 2)}

Identify:
1. What chart patterns are visible or forming?
2. Quality of potential long entries in this environment?
3. Quality of potential short entries?
4. What should the execution bot watch for in the next 4-6 hours?
5. SHORT-HORIZON MOMENTUM (mandatory): read the last ~4 hours of 1h candles
   and report a 1h read AND a 4h read (covering ~last 4 candles vs prior).
   Allowed values: "up", "down", "flat", "mixed". Use "mixed" only when bars
   genuinely conflict; do not use it as a hedge. Add ONE LINE explaining
   what just happened (e.g. "1h: sharp rejection at 65k, last 3 closes red").

The desk REQUIRES a fresh momentum read on every brief. Without it the
execution engine will refuse to propose any trade for this symbol.
`.trim();

  return callExpert(apiKey, PATTERN_RECOGNITION_SYSTEM, userMsg, "submit_pattern_brief", {
    type: "object",
    required: [
      "pattern_context",
      "entry_quality_context",
      "recent_momentum_1h",
      "recent_momentum_4h",
      "recent_momentum_notes",
    ],
    additionalProperties: false,
    properties: {
      pattern_context: {
        type: "string",
        description:
          "2-3 sentences. What patterns are visible/forming? What's the chart structure right now? Concrete prices, not generic.",
      },
      entry_quality_context: {
        type: "string",
        description:
          "2-3 sentences. What entry quality can the bot expect? Where would a HIGH quality entry be? What makes entries low quality here?",
      },
      recent_momentum_1h: {
        type: "string",
        enum: ["up", "down", "flat", "mixed"],
        description:
          "Short-horizon momentum read for the last ~1h (last 1-2 1h candles).",
      },
      recent_momentum_4h: {
        type: "string",
        enum: ["up", "down", "flat", "mixed"],
        description:
          "Short-horizon momentum read for the last ~4h (last 4 1h candles vs prior 4).",
      },
      recent_momentum_notes: {
        type: "string",
        description:
          "ONE sentence explaining the recent momentum read — what just happened on the tape that drove these calls.",
      },
    },
  }, MAFEE_MODEL);
}

// ─── Main Intelligence Loop ──────────────────────────────────────

async function runIntelligenceForSymbol(
  admin: ReturnType<typeof createClient>,
  userId: string,
  symbol: Symbol,
  apiKey: string,
  opts: { skipFreshness?: boolean } = {},
): Promise<{ skipped?: "fresh" | "no_candles"; reason?: string; ran?: string[] } | void> {
  // Load full prior row so we can carry over fields for any expert we skip.
  const { data: prevRow } = await admin
    .from("market_intelligence")
    .select("*")
    .eq("user_id", userId)
    .eq("symbol", symbol)
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  const prev = (prevRow ?? null) as any;
  const previousNarrative = (prev?.running_narrative as string | null) ?? null;

  // ── Tiered freshness gating per expert ──────────────────────────
  const now = Date.now();
  const ageMs = (iso: string | null | undefined): number =>
    iso ? now - new Date(iso).getTime() : Number.POSITIVE_INFINITY;

  const mafeeAge = ageMs(prev?.recent_momentum_at);
  // generated_at is stamped on every Hall run; if missing, treat as infinitely stale.
  const hallAge  = ageMs(prev?.generated_at);
  // Bill doesn't have its own timestamp column, so we use generated_at as a
  // conservative proxy. (Bill always co-runs with Hall on the first row.)
  const billAge  = hallAge;

  const skipFreshness = !!opts.skipFreshness;
  const runMafee = skipFreshness || mafeeAge >= MAFEE_FRESHNESS_MS;
  const runBill  = skipFreshness || billAge  >= BILL_FRESHNESS_MS;
  let runHall    = skipFreshness || hallAge  >= HALL_FRESHNESS_MS;

  // If nothing needs running, short-circuit completely (no fetches, no writes).
  if (!runMafee && !runBill && !runHall) {
    log("info", "brain_trust_all_fresh", { fn: "market-intelligence", symbol, mafeeAgeMin: Math.round(mafeeAge / 60000), billAgeMin: Math.round(billAge / 60000), hallAgeMin: Math.round(hallAge / 60000) });
    return { skipped: "fresh" };
  }

  // ── Fetch what each enabled expert needs ────────────────────────
  // Mafee needs 1h candles; Hall needs 6h + 1d; Bill needs funding/F&G/news.
  const need1h = runMafee || runHall; // pattern always wants 1h; Hall uses recent close for context
  const need6h = runHall;
  const need1d = runHall;

  const [c1hRes, c6hRes, c1dRes, fundingRes, fgRes, newsRes] = await Promise.allSettled([
    need1h ? fetchCandles(symbol, 3600)  : Promise.resolve([] as Candle[]),
    need6h ? fetchCandles(symbol, 21600) : Promise.resolve([] as Candle[]),
    need1d ? fetchCandles(symbol, 86400) : Promise.resolve([] as Candle[]),
    runBill ? fetchFundingRate(symbol)   : Promise.resolve(null),
    runBill ? fetchFearGreed()           : Promise.resolve(null),
    runBill ? fetchCryptoNews(symbol)    : Promise.resolve([] as NewsItem[]),
  ]);

  for (const [tf, res] of [["1h", c1hRes], ["6h", c6hRes], ["1d", c1dRes]] as const) {
    if (res.status === "rejected") {
      const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
      log("error", "candle_fetch_failed", { fn: "market-intelligence", symbol, timeframe: tf, err: msg });
      // Best-effort system_event audit trail — write on final failure after all retries exhausted.
      admin
        .from("system_events")
        .insert({
          user_id: userId,
          event_type: "candle_fetch_failed",
          actor: "system",
          payload: { fn: "market-intelligence", symbol, timeframe: tf, err: msg },
        })
        .then(({ error: evtErr }: { error: { message: string } | null }) => {
          if (evtErr) log("warn", "system_event_insert_failed", { fn: "market-intelligence", err: evtErr.message });
        });
    }
  }

  const candles1h = c1hRes.status === "fulfilled" ? c1hRes.value : [];
  const candles6h = c6hRes.status === "fulfilled" ? c6hRes.value : [];
  const candles1d = c1dRes.status === "fulfilled" ? c1dRes.value : [];
  const funding   = fundingRes.status === "fulfilled" ? fundingRes.value : null;
  const fg        = fgRes.status === "fulfilled" ? fgRes.value : null;
  const news      = newsRes.status === "fulfilled" ? newsRes.value : [];

  // Hall needs 6h+1d to run meaningfully — degrade gracefully if missing.
  if (runHall && (candles6h.length === 0 || candles1d.length === 0)) {
    log("warn", "expert_skipped", { fn: "market-intelligence", symbol, expert: "Hall", reason: "insufficient 6h/1d candles" });
    runHall = false;
  }
  // Mafee needs 1h candles.
  const canRunMafee = runMafee && candles1h.length > 0;
  if (runMafee && !canRunMafee) {
    log("warn", "expert_skipped", { fn: "market-intelligence", symbol, expert: "Mafee", reason: "no 1h candles" });
  }

  // Event-driven Hall trigger: if price has crossed prior S/R, force a re-run
  // even if it's still within the 15-min cooldown (regime may have shifted).
  if (!runHall && !skipFreshness && candles1h.length > 0 && prev) {
    const lastClose = candles1h[candles1h.length - 1].c;
    const prevSup = prev.nearest_support != null ? Number(prev.nearest_support) : null;
    const prevRes = prev.nearest_resistance != null ? Number(prev.nearest_resistance) : null;
    if ((prevSup != null && lastClose < prevSup) || (prevRes != null && lastClose > prevRes)) {
      log("info", "hall_sr_breach_rerun", { fn: "market-intelligence", symbol, lastClose, prevSup, prevRes });
      runHall = candles6h.length > 0 && candles1d.length > 0;
    }
  }

  // If after gating nothing actually runs, exit clean.
  if (!canRunMafee && !runBill && !runHall) {
    return { skipped: "no_candles", reason: "no expert eligible after freshness+candle checks" };
  }

  // ── Run the experts that are due ────────────────────────────────
  // Build per-expert peer-context blocks from the prior row so each expert
  // sees what its teammates last said (regime, env_rating, momentum, S/R).
  const peerForHall  = buildPeerContext(prev, "hall");
  const peerForBill  = buildPeerContext(prev, "bill");
  const peerForMafee = buildPeerContext(prev, "mafee");

  const ran: string[] = [];
  const macroPromise = runHall
    ? runMacroStrategist(apiKey, symbol, candles6h, candles1d, previousNarrative, peerForHall)
    : Promise.resolve(null);
  const cryptoPromise = runBill
    ? runCryptoIntelAnalyst(apiKey, symbol, funding, fg, news, previousNarrative, peerForBill)
    : Promise.resolve(null);

  const [macroResult, cryptoResult] = await Promise.all([macroPromise, cryptoPromise]);
  if (runHall) ran.push(macroResult ? "Hall" : "Hall(failed)");
  if (runBill) ran.push(cryptoResult ? "Bill" : "Bill(failed)");

  // Mafee runs after Hall (uses fresh S/R if available, else carries from prev row).
  const supportForMafee =
    (macroResult?.nearest_support as number | undefined) ??
    (prev?.nearest_support != null ? Number(prev.nearest_support) : null);
  const resistanceForMafee =
    (macroResult?.nearest_resistance as number | undefined) ??
    (prev?.nearest_resistance != null ? Number(prev.nearest_resistance) : null);

  const patternResult = canRunMafee
    ? await runPatternSpecialist(
        apiKey,
        symbol,
        candles1h,
        supportForMafee ?? null,
        resistanceForMafee ?? null,
        previousNarrative,
        peerForMafee,
      )
    : null;
  if (canRunMafee) ran.push(patternResult ? "Mafee" : "Mafee(failed)");

  log("info", "brain_trust_ran", {
    fn: "market-intelligence",
    symbol,
    ran: ran.join(", "),
    skipped: [!runHall && "Hall", !runBill && "Bill", !canRunMafee && "Mafee"].filter(Boolean).join(", ") || "none",
  });

  // ── Build upsert: use fresh values where we ran, else carry from prev ──
  // Carry-over helper: if expert didn't run (or returned null), keep prior value.
  const hallVal = <T>(fresh: T | undefined, prevKey: string, fallback: T): T =>
    fresh !== undefined && fresh !== null ? fresh : (prev?.[prevKey] ?? fallback);
  const billVal = <T>(fresh: T | undefined, prevKey: string, fallback: T): T =>
    fresh !== undefined && fresh !== null ? fresh : (prev?.[prevKey] ?? fallback);
  const mafeeVal = <T>(fresh: T | undefined, prevKey: string, fallback: T): T =>
    fresh !== undefined && fresh !== null ? fresh : (prev?.[prevKey] ?? fallback);

  // updated_narrative: prefer fresh from Hall, else carry forward.
  const updatedNarrative =
    (macroResult?.updated_narrative as string | undefined)?.trim() ||
    previousNarrative ||
    null;

  // news_flags: only overwrite if Bill ran successfully.
  const newsFlags = cryptoResult && Array.isArray(cryptoResult.news_flags)
    ? cryptoResult.news_flags
    : (prev?.news_flags ?? []);

  // recent_momentum_at — stamp NOW if either:
  //   (a) Mafee (the AI expert) returned both 1h and 4h reads, OR
  //   (b) we have at least 8 fresh 1h candles to compute a deterministic
  //       fallback ourselves.
  // The deterministic fallback exists so a single AI hiccup doesn't leave
  // momentum stale for hours and gate every trade with BRAIN_TRUST_MOMENTUM_STALE.
  // (Phase A1 — May 2026.)
  type MomentumRead = "up" | "down" | "flat" | "mixed";
  const computeMomentum = (cs: Candle[], window: number): MomentumRead | null => {
    if (cs.length < window * 2) return null;
    const recent = cs.slice(-window);
    const prior  = cs.slice(-window * 2, -window);
    const avg    = (xs: Candle[]) => xs.reduce((s, c) => s + c.c, 0) / xs.length;
    const recentAvg = avg(recent);
    const priorAvg  = avg(prior);
    const pct = ((recentAvg - priorAvg) / priorAvg) * 100;
    // Per-bar agreement check — if direction is mixed within the window, say so.
    const ups = recent.filter((c, i, a) => i > 0 && c.c > a[i - 1].c).length;
    const dns = recent.filter((c, i, a) => i > 0 && c.c < a[i - 1].c).length;
    const conflicted = ups > 0 && dns > 0 && Math.abs(ups - dns) <= 1;
    if (conflicted && Math.abs(pct) < 0.6) return "mixed";
    if (pct > 0.3) return "up";
    if (pct < -0.3) return "down";
    return "flat";
  };
  const fallback1h = computeMomentum(candles1h, 4);   // ~last 4h vs prior 4h
  const fallback4h = computeMomentum(candles1h, 16);  // ~last 16h vs prior 16h
  const aiHasBoth =
    !!(patternResult?.recent_momentum_1h && patternResult?.recent_momentum_4h);
  const fallbackHasBoth = !!(fallback1h && fallback4h);
  const mafeeFreshlyStamped = aiHasBoth || fallbackHasBoth;
  const usingFallback = !aiHasBoth && fallbackHasBoth;
  if (usingFallback) {
    log("warn", "mafee_momentum_fallback_used", {
      fn: "market-intelligence",
      symbol,
      reason: patternResult ? "ai_response_missing_fields" : "ai_call_failed_or_skipped",
      fallback_1h: fallback1h,
      fallback_4h: fallback4h,
      candle_count: candles1h.length,
    });
  }

  const upsertPayload = {
    user_id: userId,
    symbol,
    // ── Hall (carry over when skipped) ──
    macro_bias:           hallVal(macroResult?.macro_bias as string | undefined, "macro_bias", "neutral"),
    macro_confidence:     hallVal(macroResult?.macro_confidence as number | undefined, "macro_confidence", 0.5),
    market_phase:         hallVal(macroResult?.market_phase as string | undefined, "market_phase", "unknown"),
    trend_structure:      hallVal(macroResult?.trend_structure as string | undefined, "trend_structure", "unknown"),
    nearest_support:      hallVal(macroResult?.nearest_support as number | undefined, "nearest_support", null as number | null),
    nearest_resistance:   hallVal(macroResult?.nearest_resistance as number | undefined, "nearest_resistance", null as number | null),
    key_level_notes:      hallVal(macroResult?.key_level_notes as string | undefined, "key_level_notes", ""),
    macro_summary:        hallVal(macroResult?.macro_summary as string | undefined, "macro_summary", ""),
    // ── Bill (carry over when skipped) ──
    funding_rate_signal:  billVal(cryptoResult?.funding_rate_signal as string | undefined, "funding_rate_signal", "neutral"),
    funding_rate_pct:     billVal(cryptoResult?.funding_rate_pct as number | undefined, "funding_rate_pct", funding),
    fear_greed_score:     billVal(cryptoResult?.fear_greed_score as number | undefined, "fear_greed_score", fg?.score ?? null),
    fear_greed_label:     billVal(cryptoResult?.fear_greed_label as string | undefined, "fear_greed_label", fg?.label ?? null),
    sentiment_summary:    billVal(cryptoResult?.sentiment_summary as string | undefined, "sentiment_summary", ""),
    environment_rating:   billVal(cryptoResult?.environment_rating as string | undefined, "environment_rating", "neutral"),
    // ── Mafee (carry over when skipped — momentum_at only refreshes on a real run) ──
    pattern_context:        mafeeVal(patternResult?.pattern_context as string | undefined, "pattern_context", ""),
    entry_quality_context:  mafeeVal(patternResult?.entry_quality_context as string | undefined, "entry_quality_context", ""),
    recent_momentum_1h:     (patternResult?.recent_momentum_1h as string | undefined) ?? fallback1h ?? (prev?.recent_momentum_1h as string | null) ?? null,
    recent_momentum_4h:     (patternResult?.recent_momentum_4h as string | undefined) ?? fallback4h ?? (prev?.recent_momentum_4h as string | null) ?? null,
    recent_momentum_notes:  (patternResult?.recent_momentum_notes as string | undefined)
                              ?? (usingFallback
                                    ? `Deterministic fallback: 1h=${fallback1h ?? "n/a"}, 4h=${fallback4h ?? "n/a"} (Mafee AI unavailable).`
                                    : null)
                              ?? (prev?.recent_momentum_notes as string | null) ?? null,
    recent_momentum_at:     mafeeFreshlyStamped
      ? new Date().toISOString()
      : (prev?.recent_momentum_at ?? null),
    // ── Shared / always update ──
    running_narrative: updatedNarrative,
    news_flags: newsFlags,
    // generated_at advances whenever Hall runs (so hallAge math works next tick).
    // If only Mafee/Bill ran, keep prior generated_at so Hall's cooldown is honored.
    generated_at: runHall && macroResult
      ? new Date().toISOString()
      : (prev?.generated_at ?? new Date().toISOString()),
    candle_count_1h: candles1h.length || (prev?.candle_count_1h ?? 0),
    candle_count_4h: candles6h.length || (prev?.candle_count_4h ?? 0),
    candle_count_1d: candles1d.length || (prev?.candle_count_1d ?? 0),
  };

  const { data: upsertData, error } = await admin
    .from("market_intelligence")
    .upsert(upsertPayload, { onConflict: "user_id,symbol" })
    .select("id, user_id, symbol, generated_at, recent_momentum_at");

  if (error) {
    log("error", "intelligence_upsert_failed", { fn: "market-intelligence", userId, symbol, err: error.message, detail: JSON.stringify(error) });
    throw error;
  }
  if (!upsertData || upsertData.length === 0) {
    throw new Error(`Upsert wrote 0 rows for ${userId}/${symbol}`);
  }
  log("info", "intelligence_upsert_ok", { fn: "market-intelligence", userId, symbol, momentum_at: upsertData[0].recent_momentum_at, generated_at: upsertData[0].generated_at });
  return { ran };
}

// ─── HTTP Handler ────────────────────────────────────────────────

Deno.serve(async (req) => {
    const cors = makeCorsHeaders(req);
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  
  // Per-expert model assignment. Mafee runs every minute on a tightly-scoped
  // numeric task → cheaper flash-lite is plenty. Hall and Bill reason over text-
  // heavy macro/news context less frequently → standard flash for nuance.
  const HALL_MODEL  = "google/gemini-2.5-flash";
if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) return json({ error: "LOVABLE_API_KEY not configured" }, 500);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const authHeader = req.headers.get("Authorization") ?? "";
    let userIds: string[] = [];
    let isCron = false;

    // Cron path: shared signal-engine cron token authorizes a sweep across all running bots.
    let cronToken: string | null = null;
    try {
      const { data } = await admin.rpc("get_signal_engine_cron_token");
      cronToken = (data as string | null) ?? null;
    } catch {
      cronToken = null;
    }

    if (cronToken && authHeader === `Bearer ${cronToken}`) {
      isCron = true;
      const { data: users } = await admin
        .from("system_state")
        .select("user_id")
        .eq("bot", "running");
      userIds = (users ?? []).map((u: { user_id: string }) => u.user_id);
    } else {
      // User JWT — run for the signed-in caller on demand.
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: ud, error: ue } = await userClient.auth.getUser();
      if (ue || !ud?.user) return json({ error: "Unauthorized" }, 401);
      userIds = [ud.user.id];

      // Rate limit user-triggered runs only (cron path is system-driven).
      const rl = await checkRateLimit(admin, ud.user.id, "market-intelligence", 5);
      if (!rl.allowed) return rateLimitResponse(rl, cors);
    }

    const results: Array<{ userId: string; symbol: string; ok: boolean; error?: string }> = [];
    for (const userId of userIds) {
      for (const symbol of SYMBOL_WHITELIST) {
        try {
          await runIntelligenceForSymbol(admin, userId, symbol as Symbol, LOVABLE_API_KEY, { skipFreshness: !isCron });
          results.push({ userId, symbol, ok: true });
        } catch (e) {
          log("error", "intelligence_symbol_failed", { fn: "market-intelligence", userId, symbol, err: String(e) });
          results.push({ userId, symbol, ok: false, error: String(e) });
        }
      }
      // Refresh agent_health.brain_trust based on actual momentum freshness.
      // Status is keyed off the OLDEST short-horizon momentum_at across the
      // whitelist — that's what the engine gates on.
      try {
        const { data: rows } = await admin
          .from("market_intelligence")
          .select("symbol, recent_momentum_at, recent_momentum_1h, recent_momentum_4h")
          .eq("user_id", userId);
        const now = Date.now();
        const ages: number[] = [];
        const missing: string[] = [];
        for (const sym of SYMBOL_WHITELIST) {
          const row = (rows ?? []).find((r: { symbol: string }) => r.symbol === sym);
          const at = row?.recent_momentum_at ? new Date(row.recent_momentum_at).getTime() : null;
          if (!at || !row?.recent_momentum_1h || !row?.recent_momentum_4h) {
            missing.push(sym);
          } else {
            ages.push((now - at) / 60000);
          }
        }
        const oldest = ages.length ? Math.max(...ages) : (missing.length ? 9999 : 0);
        const status = missing.length === SYMBOL_WHITELIST.length
          ? "failed"
          : oldest > 120 ? "failed"
          : oldest > 75  ? "stale"
          : "healthy";
        const lastError = status === "healthy"
          ? null
          : missing.length
            ? `Missing momentum for: ${missing.join(", ")} (oldest ${Math.round(oldest)}m)`
            : `Oldest momentum ${Math.round(oldest)}m across ${SYMBOL_WHITELIST.length} symbols`;
        const nowIso = new Date().toISOString();
        await admin.from("agent_health").upsert(
          {
            user_id: userId,
            agent_name: "brain_trust",
            status,
            last_success: status === "healthy" ? nowIso : null,
            last_failure: status === "failed" ? nowIso : null,
            failure_count: status === "failed" ? 1 : 0,
            last_error: lastError,
            checked_at: nowIso,
          },
          { onConflict: "user_id,agent_name" },
        );
      } catch (e) {
        log("error", "agent_health_upsert_failed", { fn: "market-intelligence", userId, err: String(e) });
      }
    }

    return json({ ok: true, mode: isCron ? "cron" : "on_demand", results });
  } catch (e) {
    log("error", "handler_error", { fn: "market-intelligence", err: String(e) });
    return json({ error: String(e) }, 500);
  }
});
