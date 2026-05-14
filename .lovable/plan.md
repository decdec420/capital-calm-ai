# Why your AI balance is on fire

I traced the spend. There are four leaks running 24/7 in **paper mode with zero trades**. Together they're burning ~5–10× more AI than this account should ever need.

## What I found (evidence from your DB right now)

**Leak #1 — Quiet Mode never fires.** Last 24h: `bobby_decision` events = **1,440** (one per minute). `quiet_mode_skip` events = **0**. You have 0 open trades, 0 pending signals, 0 critical incidents, paper mode. Jessica should be skipping the heavy AI loop but isn't — every minute she sends `gemini-2.5-flash` + the full DESK_TOOLS schema, up to 3 tool-call rounds, `max_tokens: 2048`. Result: ~1,440 tool-equipped completions/day for **"No action — conditions don't warrant a move this tick."**

**Leak #2 — Signal-engine "auto-recovery" loop.** `agent_health.signal_engine.last_success` is **1,938 minutes** stale. Every Jessica tick sees `status='failed'` and fires a recovery `run_engine_tick` — which itself runs Taylor (`gemini-3-flash-preview`) + Bobby risk (`gemini-3.1-pro-preview`, the expensive one). 1,440 recovery ticks/day × 2 LLM calls each.

**Leak #3 — Brain Trust health is lying.** `agent_health.brain_trust` shows `status='failed'` with error "Stale 2174m" but `last_success` is actually **1.7 min ago**. The status field never gets reset on success. Jessica reads `failed` → calls `run_brain_trust` → that fans out to **3 LLMs (Hall, Bill, Mafee) × 3 symbols = 9 calls** per minute on top of everything else.

**Leak #4 — Pro models on hot paths.** `signal-engine` uses `gemini-3.1-pro-preview` for the risk manager on every tick. `post-trade-learn` uses it too. Pro preview is roughly 10× the price of flash. For a paper account with ~0 trades, that's pure waste.

**Bonus:** there's no per-function spend log, so you can't see which agent is eating the budget without staring at function logs.

## Quick math (rough, conservative)

Per day, in pure idle paper mode, you're paying for:

- Jessica: ~1,440 flash calls with tools
- Recovery signal-engine: ~1,440 calls (incl. 1 pro-preview each)
- Recovery brain trust: ~12,960 brain-trust LLM calls (9 × 1,440)
- market-intelligence cron (every 2m): another 9 × 720 = 6,480
- mark-to-market every 15s: thankfully no AI

Realistic ask if everything below is fixed: **~80–95% reduction** in AI spend on idle days, and ~50–70% on active days.

---

# The plan

## Phase 1 — Stop the bleeding (do first, biggest impact)

1. **Fix Quiet Mode so it actually engages.**
  - Add structured logging of the quiet-mode decision (mode + blockers list) on every Jessica tick so we can see *why* it isn't tripping today (current logs only fire on skip).
  - Patch the `recentMarketMomentumMagnitude` parser in `_shared/quiet-mode.ts` — the briefs store `"mixed" / "down" / "flat"` strings and `Number("mixed")` returns NaN; currently harmless but a footgun.
  - Verify after deploy that `quiet_mode_skip` events appear within ~5 min in idle conditions.
2. **Kill the brain-trust "always failed" lie.**
  - In `market-intelligence` (the agent that owns brain_trust health), update `agent_health.status='healthy'` AND clear `last_error` on success. Right now it only updates `last_success`, leaving stale `failed` status forever.
  - This alone removes the 9-LLM-per-minute recovery storm.
3. **Stop the signal-engine recovery storm.**
  - Add a cooldown on Jessica's "signal_engine stuck" auto-recovery: max 1 recovery attempt per 15 min per user, even if status stays failed.
  - Investigate root cause: signal-engine cron fires every minute but `last_success` is 32h stale → the function is running but never marking itself healthy. Likely the "no setup found" exit path skips the agent_health update. Patch it to always update `last_success` whenever the tick runs cleanly, regardless of whether a signal was emitted.
4. **Add a global "no work to do" gate inside Jessica before the AI call.**
  - Even with Quiet Mode fixed, add a belt-and-suspenders check: if `openTrades=0 && pendingSignals=0 && !liveTradingEnabled && lastEngineSuccess < 5min`, skip the AI loop and just write the heartbeat. Cheap insurance.

## Phase 2 — Right-size models on hot paths

5. **Demote `gemini-3.1-pro-preview` → `gemini-2.5-flash**` for:
  - `signal-engine` RISK_MANAGER_MODEL — runs every minute, doesn't need pro-grade reasoning for 95% of ticks.
  - `post-trade-learn` TRADE_COACH_MODEL — runs once per closed trade; flash is fine for the recap.
  - Keep pro-preview only for: experiment proposer (rare), regime-soft-exit decisions (safety-critical, low frequency).
6. **Trim Jessica's prompt + response budget.**
  - Drop `max_tokens` from 2048 → 768. The "no action" output is ~30 tokens; 2048 is just an upper bound but some providers bill on reservation patterns and it inflates prompt-cache misses.
  - Cap the tool-call loop at 2 rounds instead of 3.
7. **Throttle market-intelligence on idle.**
  - Change cron from every 2m → every 5m when `quiet_mode = quiet`.
  - Skip Bill (pattern) and Mafee (macro) entirely when no symbol's momentum changed since last brief — only re-run Hall (generalist).

## Phase 3 — Spend visibility (so this never happens silently again)

8. **Create `ai_call_log` table:** `{ user_id, function_name, agent, model, prompt_tokens, completion_tokens, latency_ms, created_at }`. Insert one row per AI call from a tiny shared helper.
9. **Add a "AI Spend (24h)" tile** to the existing Hall / Cron Health panel showing calls + token estimate per agent. This is the canary — if any agent spikes, you see it in seconds instead of $20 later.

---

# Technical details (skip if not interested)

- **Files touched:** `supabase/functions/_shared/quiet-mode.ts`, `supabase/functions/jessica/index.ts`, `supabase/functions/signal-engine/index.ts`, `supabase/functions/market-intelligence/index.ts`, `supabase/functions/post-trade-learn/index.ts`, plus a new `supabase/functions/_shared/ai-call-log.ts`.
- **DB migration:** new `public.ai_call_log` table with RLS (user can read own), service_role inserts only. Add `doctrine_settings.ai_daily_budget_usd numeric default 5`.
- **Cron changes:** make `market-intelligence-2m` switch to 5m via in-function early-return when quiet (don't reschedule the cron itself — keep ops simple).
- **No behavior change for live mode:** all phase 1 + 2 fixes preserve safety checks; quiet mode already requires `liveTradingEnabled=false`.
- **Verification after deploy:** within 1 hour, expect `quiet_mode_skip > 0`, `bobby_decision` count drops from ~60/hr toward ~12/hr, and `agent_health.brain_trust.status` flips to `healthy`.

---

Want me to ship Phase 1 first (the actual leaks) and pause for you to watch the spend-per-hour drop before moving to Phase 2 + 3? That's what I'd recommend — Phase 1 alone should knock the bill down hard, and we'll have real numbers from the new logger to size Phase 2.