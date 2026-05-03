
## What I found (so you trust the plan)

I queried the live DB and read the engine code. Three concrete things explain everything you're seeing:

### 1. Brain Trust "12h ago" is correct — Mafee is silently failing

`market_intelligence.recent_momentum_at` for all three symbols = **2026-05-03 04:00 UTC**. Now is ~16:50 UTC. That's 768 minutes old vs. a 120-minute gate, so the engine blocks every symbol with `BRAIN_TRUST_MOMENTUM_STALE`.

When you hit "Run full pipeline", `market-intelligence` does run (logs say `refresh_trigger_result: success`), but the **Mafee expert** (short-horizon momentum) is returning empty `recent_momentum_1h` / `recent_momentum_4h`. The function only stamps a fresh `recent_momentum_at` if **both** are populated — otherwise it carries the stale value forward. So we refresh but the freshness clock never advances. This is the dominant reason Bobby can't day-trade.

### 2. Bobby's loop is also blocked above the engine

`last_jessica_decision = "Coinbase probe failed — sitting" (reason: coinbase_unreachable)`. Bobby pings Coinbase `best_bid_ask` before every tick; if it fails she returns `skipped: true` and never invokes the engine. Two independent failures stacked on top of each other.

### 3. I was wrong about "Bobby is waiting for your approval"

There is no `signals` table (the project uses a different name now) and `pending` is empty. Nothing to approve. Apologies — that was a hallucination on my part.

### 4. Overview really is oversaturated

Current Overview renders: hero strip with embedded BTC price, gate-reason banner, 6-card metric grid, doctrine proposal banner, daily brief panel, AI insight panel ("Bobby's read"), full market intelligence panel, desk roster, open position card, kill-switches, quick actions, drilldowns. That's 10+ sections — far from a snapshot.

---

## The plan

### Phase A — Unblock trading (priority 1)

**A1. Fix Mafee so momentum actually refreshes**
- Read `market-intelligence/index.ts` Mafee path and verify why `recent_momentum_1h`/`4h` come back empty (likely AI response parsing or schema mismatch). Add a strict `safeParse`-style validator so a malformed Mafee response logs the raw payload to `system_events` instead of silently dropping the values.
- If Mafee fails, **fall back to a deterministic momentum read** computed directly from the 1h candles already fetched (simple slope over last 4 / 16 candles → up/down/flat/mixed). That way `recent_momentum_at` always advances when fresh candles arrive, and the gate doesn't trip from a single AI hiccup.
- Add a "Mafee health" entry to `agent_health` so the brain-trust freshness reason is debuggable from the UI rather than buried in logs.

**A2. Make the Coinbase probe non-fatal in paper mode**
- Bobby currently sits on `coinbase_unreachable` even when `mode = paper` and `live_trading_enabled = false`. In paper mode the probe should be informational only; the engine should still tick using cached candles + intelligence. Gate it: probe-fail blocks **only** when `live_trading_enabled = true`.
- When the probe does fail, write the underlying error (HTTP code, body snippet) to the heartbeat so we can see *why* — currently we get a generic "probe failed".

**A3. Surface the real blocker on the Overview**
- The single most useful thing on the Overview right now is "why aren't we trading?". Promote the gate-reason banner to be the first thing under the metric grid, with one-line plain-English causes ("Brain Trust momentum is 12h old — last refresh failed at Mafee step").

### Phase B — Slim the Overview to a real snapshot

Goal: open Overview and in 5 seconds know **system health, equity, and what's stopping trading**. Everything else is one tab away.

**B1. Keep on Overview (the snapshot)**
- Hero strip (mode · regime · risk posture) — but **drop the BTC-USD price block** from the hero (moves to Market Intel)
- 6-card metric grid (this is the snapshot)
- Pending-signal banner (when there is one)
- "Why the engine is sitting on hands" gate-reason banner (promoted)
- Open position one-liner (when there is one)
- Kill-switches mini-card + quick actions

**B2. Move off Overview**
- `MarketIntelligencePanel` (full version) → already lives on Market Intel; remove from Overview
- `AIInsightPanel` ("Bobby's read", on-demand `market-brief`) → fold the call-to-action into the DailyBriefPanel as a small "Get tactical update" button. The panel itself moves to the Copilot page where tactical commentary belongs.
- `DailyBriefPanel` → keep on Overview but collapsed to a 3-line summary with "Open full brief" → Copilot
- `DeskRosterStrip` → move to the Edge / Strategy Lab page, where strategy lifecycle already lives
- `DoctrineProposalBanner` → keep, but only render when there's actually a pending proposal (it's already conditional, just verify)

**B3. Replace the BTC-only price block with a 3-symbol mini-strip**
- A compact one-row strip showing BTC / ETH / SOL last price + % change + freshness dot. This is the right "snapshot" view for a 3-symbol desk and doesn't pretend BTC is special.

### Phase C — Honesty fixes

**C1. Fix the misleading "Bobby is waiting for your approval"**
- Audit the `daily-brief` and copilot prompts. The brief was probably generating that line from a stale signal count or hallucinating. Constrain the prompt: "Only mention pending approvals if `pendingSignalsCount > 0`."

**C2. Account-size sanity note**
- Equity is $9.97, max_order_pct is 0.1%, so max position is ~$0.01. Even if everything else is fixed, fills will be sub-cent and "progress" will look invisible. Add a one-line callout on the Overview metric grid when equity < $50: *"Account too small for meaningful position sizing. Consider topping up the paper balance in Settings to see strategy behavior."* No behavior change — just honesty.

---

## Technical notes (for the build phase)

```text
Files I'll touch:
  supabase/functions/market-intelligence/index.ts  (Mafee fallback + validation)
  supabase/functions/jessica/index.ts               (probe gating + better error)
  supabase/functions/daily-brief/index.ts           (prompt constraint)
  src/pages/Overview.tsx                            (slim down + 3-symbol strip)
  src/pages/Edge.tsx                                (receive DeskRosterStrip)
  src/pages/Copilot.tsx                             (receive AIInsightPanel)
  src/components/trader/DailyBriefPanel.tsx         (collapsed mode + CTA)
  src/components/trader/SymbolPriceStrip.tsx        (new — 3-symbol mini-strip)
```

```text
Order of operations:
  1. Mafee fallback + validation       → unblocks trading immediately
  2. Coinbase probe paper-mode bypass  → unblocks Bobby loop
  3. Overview slim-down                → cleaner UX, easier to read
  4. 3-symbol price strip + section moves
  5. Daily-brief prompt fix + small-account callout
```

I will **not** change doctrine limits or the kill-switch logic in this pass — that's a separate conversation about whether the guardrails themselves are too strict for a $10 paper account.

---

## What you'll see after this lands

- Brain Trust strip will show "1m ago" within one cron tick (or the next "Run full pipeline").
- Bobby will start ticking again in paper mode even when Coinbase is flaky.
- The engine will start producing `proposed` / `skipped` ticks with real reasons rather than the same `MOMENTUM_STALE` block on every symbol.
- Overview will be ~half its current height, with the snapshot up top and "why we're idle" front-and-center.
- The 3-symbol price strip replaces the BTC-only block, matching the multi-symbol reality.

Approve this and I'll execute it in the order above, surfacing checkpoints after Phase A so you can verify trading is unblocked before I touch the UI.
