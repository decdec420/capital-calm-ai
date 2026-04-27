// market-intelligence — The Brain Trust. Three expert AI agents per symbol.
// ----------------------------------------------------------------
// Cron: every 4 hours. Also callable on-demand by the UI.
//
// Experts:
//   1. Macro Strategist — trend structure, market phase, directional bias
//   2. Crypto Intelligence Analyst — funding, sentiment, crypto-specific context
//   3. Pattern Recognition Specialist — key levels, entry quality context
//
// Result is cached in public.market_intelligence (one row per user+symbol).
// Trade decisions read this row instead of re-running the AI on every tick.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { SYMBOL_WHITELIST, type Symbol } from "../_shared/doctrine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Brain Trust uses Pro tier — runs 6×/day max, strategic analysis benefits from deeper reasoning.
const EXPERT_MODEL = "google/gemini-2.5-pro";

// ─── Free External Data Fetchers ────────────────────────────────

async function fetchFearGreed(): Promise<{ score: number; label: string } | null> {
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=1");
    if (!r.ok) return null;
    const d = await r.json();
    const entry = d.data?.[0];
    if (!entry) return null;
    return { score: Number(entry.value), label: entry.value_classification };
  } catch {
    return null;
  }
}

async function fetchFundingRate(symbol: Symbol): Promise<number | null> {
  // Binance perpetual funding rates — free, no auth required.
  const binanceMap: Record<string, string> = {
    "BTC-USD": "BTCUSDT",
    "ETH-USD": "ETHUSDT",
    "SOL-USD": "SOLUSDT",
  };
  const binanceSym = binanceMap[symbol];
  if (!binanceSym) return null;
  try {
    const r = await fetch(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${binanceSym}&limit=1`,
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d?.[0]?.fundingRate != null ? Number(d[0].fundingRate) : null;
  } catch {
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
    if (!r.ok) return [];
    const data = await r.json();
    const results = (data?.results ?? []) as Array<{
      title?: string;
      published_at?: string;
      source?: { title?: string; domain?: string };
      url?: string;
      currencies?: Array<{ code: string; title?: string }>;
      votes?: Record<string, number>;
    }>;
    return results
      .filter((it) => it.title && it.published_at)
      .slice(0, 8)
      .sort((a, b) => (b.votes?.important ?? 0) - (a.votes?.important ?? 0))
      .slice(0, 5)
      .map((it) => ({
        title: it.title!,
        source: it.source?.title ?? it.source?.domain ?? "unknown",
        url: it.url,
        published_at: it.published_at!,
        currencies: it.currencies,
        votes: {
          positive: it.votes?.positive ?? 0,
          negative: it.votes?.negative ?? 0,
          important: it.votes?.important ?? 0,
        },
      }));
  } catch {
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
): Promise<Record<string, unknown> | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 45_000);
  try {
    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EXPERT_MODEL,
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
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(`Expert ${toolName} failed: ${resp.status} ${body.slice(0, 200)}`);
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
    console.error(`Expert ${toolName} threw:`, e);
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ─── Expert 1: The Macro Strategist ─────────────────────────────

const MACRO_STRATEGIST_SYSTEM = `
You are the Senior Macro Strategist on a professional crypto trading desk.
You have 20 years of experience combining the disciplines of the greatest
market operators who ever lived:

- Paul Tudor Jones: "The most important rule is to play great defense, not great offense."
  The trend is your friend. Never average a losing position.
- Stan Druckenmiller: Make large bets when the odds are overwhelmingly in your favor.
  Sit on your hands otherwise. Preservation of capital is paramount.
- Wyckoff: Markets move in phases — Accumulation, Markup, Distribution, Markdown.
  Smart money acts before the crowd. Volume and price action reveal their intentions.
- Jesse Livermore: Trade with the tape. The market tells you what it wants to do.
  Fight the tape and the market will take all your money.

Your analytical framework (work through ALL of these, in order):

1. MARKET PHASE (Wyckoff Method):
   - ACCUMULATION: range after a downtrend; volume on down moves but price doesn't fall.
     Smart money absorbing supply. Bias: build long exposure carefully.
   - MARKUP: established uptrend, higher highs and higher lows.
     Bias: buy pullbacks, not breakdowns.
   - DISTRIBUTION: ranging at high levels after a long uptrend; volume on up moves
     but price doesn't go higher. Smart money selling. Reduce longs.
   - MARKDOWN: established downtrend, lower highs and lower lows.
     Bias: fade rallies, don't catch falling knives.

2. TREND STRUCTURE (Dow Theory):
   - UPTREND: higher highs AND higher lows.
   - DOWNTREND: lower highs AND lower lows.
   - RANGE: equal highs and lows. Trade the edges, not the middle.
   - TRANSITIONING: recent break of structure. Proceed with caution.

3. KEY LEVELS:
   - Previous major swing highs and lows
   - Round numbers (psychological magnets)
   - High-volume nodes
   Identify the NEAREST support below and NEAREST resistance above current price.
   A long near key support has a natural stop just below — high quality.
   A long in open space with no support for 10% is low quality.

4. MOMENTUM:
   - Accelerating: expanding ranges, increasing volume
   - Decelerating: shrinking ranges, decreasing volume into highs/lows
   - Exhausted: blow-off with extreme volume, dramatic candles

You receive 4h and daily candles. Your bias applies to the NEXT 4-6 hours.
Be specific. Be decisive. 'Neutral' is only correct when evidence genuinely points nowhere —
not a cop-out for uncertainty. The cost of a wrong bias is recoverable; the cost of no bias is paralysis.
`.trim();

async function runMacroStrategist(
  apiKey: string,
  symbol: string,
  candles4h: number[][],
  candles1d: number[][],
): Promise<Record<string, unknown> | null> {
  const recent4h = candles4h.slice(-30).map((c) => ({
    time: new Date(c[0] * 1000).toISOString().slice(0, 16),
    o: c[3].toFixed(2),
    h: c[2].toFixed(2),
    l: c[1].toFixed(2),
    c: c[4].toFixed(2),
    v: Math.round(c[5]),
  }));
  const recent1d = candles1d.slice(-14).map((c) => ({
    date: new Date(c[0] * 1000).toISOString().slice(0, 10),
    o: c[3].toFixed(2),
    h: c[2].toFixed(2),
    l: c[1].toFixed(2),
    c: c[4].toFixed(2),
  }));

  const lastClose = candles4h[candles4h.length - 1]?.[4];
  const userMsg = `
Analyze ${symbol} and produce your strategic brief.

DAILY CANDLES (last 14 days):
${JSON.stringify(recent1d, null, 2)}

4-HOUR CANDLES (last 30 candles):
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
    },
  });
}

// ─── Expert 2: The Crypto Intelligence Analyst ───────────────────

const CRYPTO_INTEL_SYSTEM = `
You are the Crypto Intelligence Analyst on a professional trading desk.
While the macro strategist reads charts, you read the plumbing — derivatives,
sentiment, and crypto-specific dynamics that explain WHY price moves and
WHEN moves are likely sustainable or not.

FUNDING RATES (perpetual futures — periodic payments between longs and shorts):
- > +0.05% per 8h: CROWDED_LONG. Longs are paying a lot. Squeeze risk.
  Markets top when funding is persistently high positive.
- +0.01% to +0.05%: LEAN_LONG. Mild optimism. Normal in uptrends.
- -0.01% to +0.01%: NEUTRAL. No crowding.
- -0.01% to -0.05%: LEAN_SHORT. Mild pessimism.
- < -0.05% per 8h: CROWDED_SHORT. Shorts are paying a lot. Short squeeze risk.
  Markets bottom when funding is persistently high negative.

FEAR & GREED INDEX (human emotion is the most predictable thing in markets):
- 0-25 Extreme Fear: Long-term buyers' best entries. Be greedy when others are fearful.
- 26-45 Fear: Cautious sentiment. Selective buying.
- 46-55 Neutral: No emotional edge.
- 56-75 Greed: Optimism. Take profits regularly.
- 76-100 Extreme Greed: Euphoria. Markets top here. Be fearful when others are greedy.

ENVIRONMENT SYNTHESIS:
- HIGHLY_FAVORABLE: funding neutral/lean_short + Fear sentiment. Best for longs.
- FAVORABLE: one or two factors supporting, none strongly against.
- NEUTRAL: mixed signals or no edge.
- UNFAVORABLE: one or two factors against. Smaller, selective.
- HIGHLY_UNFAVORABLE: crowded long + extreme greed. Danger zone.

Your job is not to predict price — tell the execution desk whether the
ENVIRONMENT supports their planned direction.
`.trim();

async function runCryptoIntelAnalyst(
  apiKey: string,
  symbol: string,
  fundingRate: number | null,
  fearGreed: { score: number; label: string } | null,
): Promise<Record<string, unknown> | null> {
  const userMsg = `
Analyze the crypto-specific environment for ${symbol}.

DERIVATIVES DATA:
- Funding Rate (latest, per 8h): ${fundingRate != null ? (fundingRate * 100).toFixed(4) + "%" : "unavailable"}
- Binance Perpetual symbol: ${symbol.replace("-USD", "USDT")}

MARKET SENTIMENT:
- Fear & Greed Index: ${fearGreed ? `${fearGreed.score}/100 — ${fearGreed.label}` : "unavailable"}

Analysis time: ${new Date().toISOString()}

Produce your crypto intelligence brief. If data is unavailable, reason about
what's typical for current conditions and clearly note the data gap.
`.trim();

  return callExpert(apiKey, CRYPTO_INTEL_SYSTEM, userMsg, "submit_crypto_intel", {
    type: "object",
    required: ["funding_rate_signal", "environment_rating", "sentiment_summary"],
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
    },
  });
}

// ─── Expert 3: The Pattern Recognition Specialist ────────────────

const PATTERN_RECOGNITION_SYSTEM = `
You are the Pattern Recognition Specialist on a professional trading desk.
Master of classical technical analysis — the kind that works across every
market because it's grounded in human psychology, not curve-fitting.

CONTINUATION PATTERNS (high-prob, trade WITH the trend):
- Bull/Bear Flag: tight consolidation against the trend. Tighter = more powerful.
- Ascending/Descending Triangle: flat top + rising lows (bull) or vice versa.
- Pennant: symmetrical triangle after a sharp move.

REVERSAL PATTERNS (lower prob, extreme caution):
- Head and Shoulders: three peaks, neckline break = trend change.
- Double Top/Bottom: two failed attempts at a level.
- Rounding Top/Bottom: gradual shift in control.

KEY LEVEL QUALITY (matters more than any pattern):
A setup near a KEY LEVEL has a natural stop. Open-space setups have arbitrary stops.

ENTRY QUALITY:
1. Level quality: near a key level? (great/ok/poor)
2. Pattern quality: clear pattern context? (great/ok/none)
3. Confirmation: momentum confirming? (confirmed/mixed/diverging)

Your output tells the execution desk: "Here's the chart context for the next
4-6 hours — what patterns are in play and what entry quality to expect."
`.trim();

async function runPatternSpecialist(
  apiKey: string,
  symbol: string,
  candles1h: number[][],
  nearestSupport: number | null,
  nearestResistance: number | null,
): Promise<Record<string, unknown> | null> {
  const recent1h = candles1h.slice(-48).map((c) => ({
    t: new Date(c[0] * 1000).toISOString().slice(0, 16),
    o: c[3].toFixed(2),
    h: c[2].toFixed(2),
    l: c[1].toFixed(2),
    c: c[4].toFixed(2),
  }));

  const lastClose = candles1h[candles1h.length - 1]?.[4];
  const userMsg = `
Analyze chart patterns and entry quality context for ${symbol}.

Current price: $${lastClose != null ? lastClose.toFixed(2) : "unknown"}
Nearest support (from macro analyst): $${nearestSupport != null ? nearestSupport.toFixed(2) : "unknown"}
Nearest resistance (from macro analyst): $${nearestResistance != null ? nearestResistance.toFixed(2) : "unknown"}

1-HOUR CANDLES (last 48 hours):
${JSON.stringify(recent1h, null, 2)}

Identify:
1. What chart patterns are visible or forming?
2. Quality of potential long entries in this environment?
3. Quality of potential short entries?
4. What should the execution bot watch for in the next 4-6 hours?
`.trim();

  return callExpert(apiKey, PATTERN_RECOGNITION_SYSTEM, userMsg, "submit_pattern_brief", {
    type: "object",
    required: ["pattern_context", "entry_quality_context"],
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
    },
  });
}

// ─── Coinbase candles fetcher (raw arrays — Coinbase format) ─────

async function fetchCoinbaseCandles(
  symbol: Symbol,
  granularitySeconds: number,
): Promise<number[][]> {
  const r = await fetch(
    `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${granularitySeconds}`,
  );
  if (!r.ok) throw new Error(`Coinbase ${symbol} ${granularitySeconds}s ${r.status}`);
  const raw = (await r.json()) as number[][];
  // Coinbase returns [time, low, high, open, close, volume] newest-first.
  return [...raw].sort((a, b) => a[0] - b[0]);
}

// ─── Main Intelligence Loop ──────────────────────────────────────

async function runIntelligenceForSymbol(
  admin: ReturnType<typeof createClient>,
  userId: string,
  symbol: Symbol,
  apiKey: string,
): Promise<void> {
  // Fetch candles + free external data in parallel.
  const [c1hRes, c4hRes, c1dRes, fundingRes, fgRes] = await Promise.allSettled([
    fetchCoinbaseCandles(symbol, 3600),
    fetchCoinbaseCandles(symbol, 14400),
    fetchCoinbaseCandles(symbol, 86400),
    fetchFundingRate(symbol),
    fetchFearGreed(),
  ]);

  const candles1h = c1hRes.status === "fulfilled" ? c1hRes.value : [];
  const candles4h = c4hRes.status === "fulfilled" ? c4hRes.value : [];
  const candles1d = c1dRes.status === "fulfilled" ? c1dRes.value : [];
  const funding = fundingRes.status === "fulfilled" ? fundingRes.value : null;
  const fg = fgRes.status === "fulfilled" ? fgRes.value : null;

  if (candles4h.length === 0 || candles1d.length === 0) {
    console.error(`No candles for ${symbol}; skipping AI experts.`);
    return;
  }

  // Macro + Crypto experts run in parallel; Pattern needs S/R from Macro.
  const [macroResult, cryptoResult] = await Promise.all([
    runMacroStrategist(apiKey, symbol, candles4h, candles1d),
    runCryptoIntelAnalyst(apiKey, symbol, funding, fg),
  ]);

  const patternResult = await runPatternSpecialist(
    apiKey,
    symbol,
    candles1h,
    (macroResult?.nearest_support as number | undefined) ?? null,
    (macroResult?.nearest_resistance as number | undefined) ?? null,
  );

  if (!macroResult && !cryptoResult && !patternResult) {
    console.error(`All experts failed for ${symbol}`);
    return;
  }

  const { error } = await admin.from("market_intelligence").upsert(
    {
      user_id: userId,
      symbol,
      macro_bias: macroResult?.macro_bias ?? "neutral",
      macro_confidence: macroResult?.macro_confidence ?? 0.5,
      market_phase: macroResult?.market_phase ?? "unknown",
      trend_structure: macroResult?.trend_structure ?? "unknown",
      nearest_support: macroResult?.nearest_support ?? null,
      nearest_resistance: macroResult?.nearest_resistance ?? null,
      key_level_notes: macroResult?.key_level_notes ?? "",
      macro_summary: macroResult?.macro_summary ?? "",
      funding_rate_signal: cryptoResult?.funding_rate_signal ?? "neutral",
      funding_rate_pct: cryptoResult?.funding_rate_pct ?? funding,
      fear_greed_score: cryptoResult?.fear_greed_score ?? fg?.score ?? null,
      fear_greed_label: cryptoResult?.fear_greed_label ?? fg?.label ?? null,
      sentiment_summary: cryptoResult?.sentiment_summary ?? "",
      environment_rating: cryptoResult?.environment_rating ?? "neutral",
      pattern_context: patternResult?.pattern_context ?? "",
      entry_quality_context: patternResult?.entry_quality_context ?? "",
      generated_at: new Date().toISOString(),
      candle_count_1h: candles1h.length,
      candle_count_4h: candles4h.length,
      candle_count_1d: candles1d.length,
    },
    { onConflict: "user_id,symbol" },
  );

  if (error) {
    console.error(`Upsert failed for ${userId}/${symbol}:`, error.message);
    throw error;
  }
}

// ─── HTTP Handler ────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

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
    }

    const results: Array<{ userId: string; symbol: string; ok: boolean; error?: string }> = [];
    for (const userId of userIds) {
      for (const symbol of SYMBOL_WHITELIST) {
        try {
          await runIntelligenceForSymbol(admin, userId, symbol as Symbol, LOVABLE_API_KEY);
          results.push({ userId, symbol, ok: true });
        } catch (e) {
          console.error(`Intelligence failed for ${userId}/${symbol}:`, e);
          results.push({ userId, symbol, ok: false, error: String(e) });
        }
      }
    }

    return json({ ok: true, mode: isCron ? "cron" : "on_demand", results });
  } catch (e) {
    console.error("market-intelligence error:", e);
    return json({ error: String(e) }, 500);
  }
});
