# Why Bobby Never Pulls the Trigger
## A Full-Stack Audit of capital-calm-ai · May 2026

---

## The Short Answer

Bobby is not broken. He is doing exactly what he was built to do — and that is the problem.

Every gate in this system was written with "preserve capital first" as the prime directive. The doctrine literally encodes the principle `noTradeIsValid: true`. When you add up 15+ independent veto layers, each defaulting to *don't trade* on any uncertainty, the probability of all conditions being simultaneously green is extremely low. Bobby is a fund manager who was handed a rulebook that treats every untaken trade as a win.

Bobby Axelrod would burn that rulebook.

---

## The Architecture: A One-Way Ratchet

The signal-engine runs a waterfall of gates. **Any single gate can kill the tick.** None of them can force a trade. This is the fundamental asymmetry:

```
Regime gate → Setup score → Freshness → Anti-tilt → Risk gates → 
Taylor (AI #1) → Confidence check → Coach penalty → Cost gate → 
Bobby (AI #2) → Autonomy gate → Daily cap → Execute
```

Every stage is a potential exit. There is no stage that *pushes* toward execution. The system is architecturally biased toward inaction.

---

## Gate-by-Gate Diagnosis

### 1. The Profile: Sentinel Mode Is a Museum, Not a Trading Desk

If you're running on the default `sentinel` profile — and you likely are, because that's the system default — you are operating under these hard caps, enforced in code with a `validateDoctrineInvariants()` call that throws at cold-start if the numbers are loosened:

| Constraint | Sentinel | Active | Aggressive |
|---|---|---|---|
| Max order size | **$1** | $5 | $25 |
| Max trades/day | **5** | 15 | 30 |
| Max daily loss | **$2** | $10 | $50 |
| Scan interval | 5 min | 2 min | 1 min |

A $1 order on a $100 account is 1% position sizing. After fees and slippage, you need a 2.8% move just to break even (see Gate #9 below). A 2.8% move on BTC from a $1 position is $0.028. This is cosmetically a trading system but functionally a paper journal. **The profile is the single biggest lever in the entire system.**

**Impact if changed**: Switching to `active` gives 5× the per-order size, 3× the daily trades, and 5× the loss budget — before touching a single line of logic.

---

### 2. The Regime Filter: Most of the Time the Market Is Locked Out

Only three regimes are tradeable: `trending_up`, `trending_down`, `breakout`. The regimes `range` and `chop` are permanently blocked, and `no_trade` is self-explanatory.

```typescript
// regime.ts — line 25
export const TRADEABLE_REGIMES: ReadonlySet<RegimeLabel> = new Set([
  "trending_up", "trending_down", "breakout"
]);
```

Crypto markets spend the **majority of their time in range or chop** — estimates vary, but 60–70% of hourly candles in mature crypto markets are non-trending. The drift ratio threshold for "trending" is 0.55, meaning the absolute net move must be more than 55% of the total high-low range. That is a meaningful filter. Legitimate — but it means Bobby is structurally prohibited from trading most of the time, regardless of what his other signals say.

This isn't entirely wrong. Trending-only is a reasonable strategy. But combined with every other gate, it creates long windows of complete inactivity.

**Impact if changed**: Adding `range` as conditionally tradeable (mean-reversion when RSI is at extremes) could roughly double the number of eligible market conditions.

---

### 3. The Setup Score: A Formula That Starts Below Threshold

The `setupScore` formula in `regime.ts` is:

```
setupScore = confidence × 0.35 + todScore × 0.25 + trendBoost + volBoost + pullbackBoost
```

Where:
- `trendBoost`: 0.25 for trending/breakout, 0.10 for trending_down, **0 for range/chop**
- `volBoost`: 0.20 for normal vol, 0.05 for low, **0 for elevated/extreme**
- `pullbackBoost`: 0.20, but **only** if price touched the fast EMA AND RSI was <45 curling up AND it's already an uptrend
- `todScore`: 0.85 for 13–21 UTC, **0.55 for 07–23 UTC off-peak, 0.30 outside that**

In a legitimately trending market during off-peak hours (todScore = 0.55) with moderate confidence (0.70) and no pullback:

```
0.70 × 0.35 + 0.55 × 0.25 + 0.25 + 0.20 + 0 = 0.245 + 0.1375 + 0.25 + 0.20 = 0.8325
```

That passes. But regime.ts then checks `setupScore < 0.65` and adds it to `noTradeReasons`. Signal-engine's actual gate is `MIN_SETUP_SCORE = isPaper ? 0.45 : 0.55`, which is lower — but the AI *reads the noTradeReasons array* and uses them in its prompt reasoning. Taylor (the Technical Analyst AI) will see "Setup score 0.62 below 0.65" in its context and interpret this as a reason to skip, even when the code gate would pass.

**This is a bug disguised as a feature**: The regime module's 0.65 advisory is stricter than signal-engine's 0.55 gate, and the AI treats the advisory as authoritative.

---

### 4. The Time-of-Day Filter: 16 Hours of Suboptimal Scoring

Only 13:00–21:00 UTC (8 hours) earns the full 0.85 `todScore`. Everything from 07:00–23:00 UTC gets 0.55 — a 35% penalty on one-quarter of the formula weight. Outside 07:00–23:00 UTC, the score is 0.30, which essentially guarantees a setup score failure in anything but the strongest trending market.

The rationale — trade in liquid hours — is sound. The implementation — hard-coded score penalty with no user control — is not. A user in the US (UTC-5) who runs the bot at 8 PM local time is in the 0.55 penalty zone. They never get the full score unless they're active during European/US market open.

---

### 5. The Prompt Philosophy: Bobby Was Told Not To Trade

This is in the live-mode system prompt for the Technical Analyst, verbatim:

```
A SKIP IS NOT FAILURE. Most ticks should be skips.
The edge is in the quality of trades taken, not the quantity.
"The money is made in the waiting." — Jesse Livermore
```

And in the Risk Manager (Bobby) prompt:

```
"I'm always thinking about losing money rather than making money."
Don't focus on the upside. Obsess over the downside.
```

You have literally instructed both AI agents, in writing, that *not trading is the correct default behavior*. For a system trying to calibrate conservative trading, this makes sense during early development. For a system where the complaint is "Bobby never trades," this is the smoking gun.

The AI does what it's told. You told it to wait.

**This is the highest-leverage change in the entire roadmap.** Rewriting two paragraphs of prompt language will have more impact on trade frequency than any code change.

---

### 6. The Environment Threshold Escalator

The Technical Analyst's prompt includes:

```
- neutral: Raise confidence threshold by 0.1
- unfavorable: Raise confidence threshold by 0.2. Reduce size.
- highly_unfavorable: Do NOT trade unless confidence > 0.85
```

"Neutral" is not a bad environment. Neutral means nothing exceptional is happening. But the system treats it as a reason to require *more* confidence. In practice, `market-intelligence` will classify many sessions as neutral — markets are neutral most of the time. So the effective live confidence threshold is often `0.65 + 0.10 = 0.75`, not 0.65.

A 0.75 confidence requirement is extremely high for an AI trading system. For reference: the auto-execute bar for "assisted" mode is 0.85.

---

### 7. Bobby's Fail-Safe: AI Failure = Automatic Veto

When the Risk Manager AI call fails (network timeout, parse error, HTTP error):

```typescript
// signal-engine/index.ts — runRiskManager()
if (!resp.ok) {
  cbFailure();
  return { verdict: "veto", reason: "Risk manager unavailable — failing safe." };
}
const args = d.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
if (!args) {
  cbFailure();
  return { verdict: "veto", reason: "Risk manager parse error — failing safe." };
}
```

A trade that survived all prior gates — regime, freshness, anti-tilt, Taylor's full analysis, confidence check, coach penalty, cost gate — gets silently killed if Claude has a bad 30 seconds. The circuit breaker then opens after 3 consecutive failures and blocks all AI calls for 60 seconds.

This fail-safe is appropriate for a system handling real money. But for a system that is barely trading, it means any LLM reliability blip is a trade missed. The correct behavior for a *missed opportunity* is not `veto` — it should be `skip_tick` (try again in 5 minutes), which is architecturally different from permanently rejecting the signal.

---

### 8. The Auto-Execute Gate: Effectively Disabled

```typescript
// signal-engine/index.ts — line 2522
const autonomy = sys.autonomy_level ?? "manual";
const dailyAutoCapUsd = Number(acct?.daily_auto_execute_cap_usd ?? 2.0);

// line 2559
const canAutoExecute =
  (autonomy === "autonomous" || (autonomy === "assisted" && conf >= 0.85));
```

Three problems here:

**Problem A** — The default is `"manual"`, meaning if `autonomy_level` is null in the database (which it is for a new user), Bobby proposes trades but never executes them. Signals pile up in the pending queue. No one clicks approve. They expire.

**Problem B** — If you're in `"assisted"` mode, auto-execute only fires at `conf >= 0.85`. After all the environment adjustments, coach penalties, and the AI's own conservatism, reaching 0.85 is exceptional. Practically speaking, "assisted" = "manual."

**Problem C** — `daily_auto_execute_cap_usd` defaults to **$2.00**. On Sentinel ($1/order), you get two auto-executes per day before the cap closes. On Active ($5/order), you get zero auto-executes unless you raise the cap.

Unless you are actively monitoring the UI and clicking approve, **the system is not trading**. It is generating signals into a void.

---

### 9. The Cost Gate: Demanding a 2.8% Free Lunch

```typescript
// Conservative defaults: 0.6% fee + 0.1% slippage per side = 1.4% round-trip
// Edge multiplier required: 2×
// minEdgePctRequired = 1.4% × 2 = 2.8%
```

The system requires the expected move to TP1 to be ≥ 2.8% just to be considered. That's actually a *generous* estimate for Coinbase taker fees on BTC (which can be 0.2–0.4% per side for active traders), and it's conservative for ETH/SOL.

The logic is correct for a system that charges full taker rates on every trade. **However**: if you use limit orders (maker fills), fees drop to ~0.1–0.2% per side, and the required edge drops to ~0.8–1.2%. The current implementation has no path for limit orders — it's market-buy only. This means you're always paying taker rates, and the cost gate is legitimately high.

This is a correctness issue, not a conservatism issue. The gate is right for the execution method. The execution method is expensive.

---

### 10. The Anti-Tilt System: Triggers in Normal Volatility

```typescript
// Default limits (from doctrineRow, defaults to):
// consecutive_loss_limit: 4  → hard stop
// cooldown_threshold:     3  → 30-min pause
// caution_threshold:      2  → size reduce + confidence tighten
```

In a volatile crypto session — BTC drops 3%, your long stops out, SOL drops 2%, your long stops out, ETH bounces and you get chopped — you're at caution after trade 2, cooldown after trade 3, hard stop after trade 4. On Sentinel with 5 trades/day, **hitting caution costs you 1-2 of your 5 daily trade slots before the system clears**.

In a choppy day (which is most days, per Gate #2), you can burn through your loss budget and your anti-tilt budget simultaneously, leaving the system sitting on its hands by mid-session. The anti-tilt system is designed for a funded account running 20+ trades/day. At 5 trades/day, the thresholds trigger too fast.

---

## The Compound Effect

No single gate explains the hesitancy. The problem is multiplicative. Consider the probability that all conditions are green on a given 5-minute tick:

- Market in tradeable regime: ~30-40% of ticks
- Prime trading hours (13-21 UTC): ~33% of the day
- Momentum data fresh: ~90% (assuming cron works)
- No anti-tilt block: ~80% (early session)
- Taylor proposes a trade: ~20-30% of eligible ticks (he's conservative by instruction)
- Bobby approves: ~60-70% (when a trade IS proposed)
- Confidence ≥ threshold: ~50% (after environment adjustments)
- Cost gate clears: ~70% (depends on volatility)
- Autonomy allows auto-execute: ~10% (if in assisted mode, conf ≥ 0.85)

**Multiplied: 0.35 × 0.33 × 0.90 × 0.80 × 0.25 × 0.65 × 0.50 × 0.70 × 0.10 ≈ 0.07%**

Roughly 1 in 1,400 ticks auto-executes. At a 5-minute scan interval, that's **once every 4–5 days**, on Sentinel, in assisted mode. This is the math of the system as configured.

---

## The Roadmap: Fixing Bobby in Four Acts

The following is organized by impact and risk. Act I changes the configuration — no code. Act II rewrites the AI instructions — lowest-risk code change. Act III relaxes specific numeric thresholds — medium risk. Act IV addresses structural issues that require more thought.

---

### Act I: Configuration Changes (Do These Today)

These are database/settings changes with no code deployment required.

**I-A. Set the active profile to `active` or `aggressive`**

In the `system_state` table: set `active_profile = 'active'`. This is the single highest-impact change available. It raises your per-order cap from $1 to $5, your daily trades from 5 to 15, and your loss budget from $2 to $10. Nothing else you can do has this magnitude of effect.

If your account size warrants it and you want to see real results, `aggressive` ($25/order, 30/day, $50 daily loss) is the Bobby Axelrod profile.

**I-B. Set autonomy to `autonomous`**

In `system_state`: set `autonomy_level = 'autonomous'`. This is required for the system to execute without manual approval. Without this, every signal sits in a pending queue until it expires.

**I-C. Raise `daily_auto_execute_cap_usd`**

In `account_state`: set `daily_auto_execute_cap_usd` to a meaningful number relative to your account — suggested $25–$50 for a $500+ account. At $2, the cap closes after two Sentinel trades. On Active profile with $5 orders, you need this set to at least $75 to not hit it during a normal trading day.

---

### Act II: Prompt Recalibration (Highest-Leverage Code Change)

These changes require a code deployment but are low risk — they modify AI instructions, not execution logic.

**II-A. Remove the explicit "most ticks should be skips" instruction**

In `signal-engine/index.ts`, in the live-mode system prompt (the `!isPaper` branch), remove:

```
A SKIP IS NOT FAILURE. Most ticks should be skips.
The edge is in the quality of trades taken, not the quantity.
"The money is made in the waiting." — Jesse Livermore
```

Replace with:

```
Capital protection and trade quality must coexist. Protect against bad setups.
Do not protect against good ones. A missed A+ setup is a real loss — not neutral.
```

**II-B. Calibrate the environment threshold escalation**

In the Technical Analyst system prompt, change the environment filter from:

```
- neutral: Raise confidence threshold by 0.1
- unfavorable: Raise confidence threshold by 0.2.
```

To:

```
- neutral: Apply standard thresholds. Neutral is not a reason to hesitate.
- unfavorable: Raise confidence threshold by 0.1. Reduce size by 20%.
- highly_unfavorable: Do NOT trade unless confidence > 0.80.
```

This alone drops the effective live threshold from 0.75 back to 0.65 in neutral markets.

**II-C. Change Bobby's fail-safe default from veto to skip_tick**

In `runRiskManager()`, change the AI failure response from returning `{ verdict: "veto" }` to `{ verdict: "skip_tick" }`, and add a case for it upstream that simply returns early without inserting a rejected signal. The semantics change from "this trade is bad" to "I couldn't evaluate this trade right now — try again next tick." A veto poisons the signal record. A skip_tick is invisible.

---

### Act III: Threshold Recalibration (Deploy with Care)

**III-A. Decouple regime.ts's advisory from signal-engine's gate**

`regime.ts` pushes `setupScore < 0.65` into `noTradeReasons`. Signal-engine gates at 0.55 live. This creates a contradiction: the code allows the trade but the AI context says no.

Fix: change regime.ts's `noTradeReasons` threshold to match signal-engine:

```typescript
// regime.ts — change from:
if (setupScore < 0.65) {
  noTradeReasons.push(`Setup score ${setupScore.toFixed(2)} below 0.65`);
}
// to:
if (setupScore < 0.55) {  // matches signal-engine live threshold
  noTradeReasons.push(`Setup score ${setupScore.toFixed(2)} below 0.55`);
}
```

**III-B. Raise the anti-tilt consecutive loss limit to 6**

The current limit of 4 (hard stop), 3 (cooldown), 2 (caution) is calibrated for a high-frequency system. For a 5–15 trades/day system, 4 consecutive losses in a volatile session is not a sign of broken logic — it's a sign of a bad market day. The threshold should reflect session frequency.

Change `consecutive_loss_limit` default to 6 (hard stop at 6, cooldown at 5, caution at 4). This gives more room before the system parks itself.

**III-C. Reduce per-symbol re-entry cooldown from 30 to 15 minutes**

`loss_cooldown_minutes` defaults to 30. For a 5-minute scan interval, that's 6 missed ticks on that symbol after any loss. Reducing to 15 minutes (3 ticks) still provides the protective re-entry pause without burning half a session window.

---

### Act IV: Structural Changes (Deliberate, Phase These In)

**IV-A. Add a mean-reversion playbook for range regimes**

The current strategy router only activates during trending/breakout. Adding a range-bound mean-reversion strategy (buy oversold RSI at support, sell overbought RSI at resistance) as a separate playbook — with deliberately lower size caps — would give Bobby something to do during the 60–70% of market time that is currently locked out. This is how real desks operate: trend-following AND mean-reversion running in parallel, with regime determining which playbook is live.

This is a non-trivial addition to `strategy-router.ts` and `regime.ts` but it directly addresses the root cause of why Bobby sits on his hands most of the time.

**IV-B. Explore limit order execution**

The cost gate requires 2.8% expected edge because it assumes taker fees (0.6% per side). If the system placed limit orders on pulls to the fast EMA, maker fees on Coinbase Advanced are ~0.1–0.2% per side — the required edge drops to ~0.8–1.2%. This is a significant expansion of tradeable setups, especially in lower-volatility sessions where the current cost gate kills many legitimate entries.

This requires a broker layer change but the payoff is substantial.

**IV-C. Surface tunable parameters in the UI**

Currently, `autonomy_level`, `daily_auto_execute_cap_usd`, `consecutive_loss_limit`, `loss_cooldown_minutes`, and `active_profile` all require direct database writes to change. The Edge page shows strategy performance but cannot modify execution parameters. Building a "Bobby's Desk" settings panel in the UI would let you tune these without code deploys or SQL access.

---

## Priority Summary

| # | Change | Type | Impact | Risk | Effort |
|---|---|---|---|---|---|
| I-A | Switch to `active` or `aggressive` profile | Config | ★★★★★ | Low | Minutes |
| I-B | Set `autonomy_level = autonomous` | Config | ★★★★★ | Low | Minutes |
| I-C | Raise `daily_auto_execute_cap_usd` to $50+ | Config | ★★★★☆ | Low | Minutes |
| II-A | Remove "skips are success" prompt language | Prompt | ★★★★☆ | Low | 30 min |
| II-B | Fix environment neutral threshold escalation | Prompt | ★★★☆☆ | Low | 30 min |
| II-C | Bobby fail-safe: veto → skip_tick | Code | ★★★☆☆ | Low | 1 hour |
| III-A | Align regime.ts advisory to 0.55 | Code | ★★★☆☆ | Low | 30 min |
| III-B | Anti-tilt limit: 4 → 6 | Code | ★★☆☆☆ | Medium | 30 min |
| III-C | Cooldown: 30 min → 15 min | Code | ★★☆☆☆ | Low | 30 min |
| IV-A | Range regime / mean-reversion playbook | Feature | ★★★★☆ | Medium | 1–2 weeks |
| IV-B | Limit order execution | Feature | ★★★★☆ | High | 2–3 weeks |
| IV-C | UI settings panel for execution params | Feature | ★★★☆☆ | Low | 1 week |

---

## The Real Bobby Axelrod Note

Axelrod is not reckless. He is decisive. The difference between the current system and a Bobby-like system is not removing the risk controls — it's changing what the default is. 

Right now, the default is "sit." Every condition that is uncertain defaults to no. The AI agents are explicitly told that not trading is success.

A Bobby-like system has the same controls, but the default is "evaluate." Uncertainty about the environment doesn't raise the threshold — it prompts more scrutiny. A missed A+ setup is logged as a cost, not ignored. The AI agents are told that both false positives (bad trades) and false negatives (missed trades) are real losses to the desk.

The capital preservation principles are sound. The profile caps are appropriate risk management. The regime filter, the R/R requirement, Bobby's veto authority — these are right. What is wrong is the *posture*: a system that was designed to prove to itself that it shouldn't trade, rather than to find trades worth taking.

Acts I and II — the configuration changes and the prompt rewrites — cost nothing, require no code review, and will have more impact on Bobby's trade frequency than any architectural change in this document.

Start there.

---

*Audit conducted May 2026 | Code references: signal-engine/index.ts, _shared/risk.ts, _shared/doctrine.ts, _shared/regime.ts, _shared/sizing.ts*
