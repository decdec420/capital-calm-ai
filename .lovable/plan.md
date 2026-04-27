
# Watchdog: Two-Layer Health Monitoring

Your instinct is right. Claude's prompt is **Option A done well** — Jessica becomes a thoughtful watchdog of the other agents and Harvey reports issues proactively. But it has the gap you spotted: **nobody watches Jessica**. If her cron silently dies, the whole health system goes blind without any alarm.

Adding **Option C (a Postgres heartbeat)** alongside it costs almost nothing and closes that gap. Postgres is the most reliable component you have, it can't be killed by a Deno runtime crash, and it already powers your existing alert triggers.

## What we're building

```text
  ┌─────────────────────────────────────────────────────────────┐
  │  Layer 1: Jessica (every 60s)                               │
  │  Watches: brain_trust, signal_engine, herself               │
  │  Writes: agent_health rows                                  │
  │  Recovers: auto-fires run_brain_trust if stale              │
  └────────────────────────┬────────────────────────────────────┘
                           │ writes to
                           ▼
                    agent_health table
                           ▲
                           │ reads from
  ┌────────────────────────┴────────────────────────────────────┐
  │  Layer 2: Postgres heartbeat (every 3 min, pg_cron)         │
  │  Watches: ONLY Jessica's last_jessica_decision freshness    │
  │  Writes: alerts row + agent_health row for jessica          │
  │  Cannot recover — its job is to scream loudly               │
  └─────────────────────────────────────────────────────────────┘
                           ▲
                           │ reads
                           │
  ┌────────────────────────┴────────────────────────────────────┐
  │  Layer 3: Harvey (when you open Copilot)                    │
  │  Reads: agent_health + recent alerts                        │
  │  Surfaces: any degraded/failed agent in his next response   │
  └─────────────────────────────────────────────────────────────┘
```

The key insight: **Jessica + Postgres watch each other.** If Jessica dies, Postgres notices in <5 minutes. If Postgres pg_cron dies, Jessica notices her own missing heartbeat on the next tick. Both have to fail simultaneously for you to be blind, which is vastly less likely than either failing alone.

---

## Plan

### Step 1 — Adopt Claude's prompt as written, with two corrections

Implement everything in Claude's prompt (steps 1–4). It's well-designed. Two small fixes:

- **The `agent_health` migration uses `REFERENCES auth.users(id)`.** Per your project rules, app tables shouldn't FK into `auth.users`. Drop the `REFERENCES auth.users(id) ON DELETE CASCADE` clause — the RLS policy `auth.uid() = user_id` is the actual safety net.
- **Add an `INSERT/UPDATE` RLS policy for the service role.** The current policy is SELECT-only for users, which is correct, but Jessica's upserts run via service role so they bypass RLS — that's fine. Just confirming no policy needs to allow user-side writes (it doesn't).

### Step 2 — Add a fourth agent: `jessica_heartbeat` (Option C)

Create one more migration that adds a Postgres function and pg_cron job:

**`check_jessica_heartbeat()`** — runs every 3 minutes:
1. For each row in `system_state`, look at `last_jessica_decision->>'ran_at'`.
2. If null or older than 4 minutes:
   - Upsert `agent_health` with `agent_name='jessica_heartbeat'`, `status='failed'`, `last_error='Jessica has not ticked in N minutes — cron may be down'`.
   - Insert an `alerts` row (severity `critical`, title `Jessica heartbeat lost`) — but only if no identical alert exists from the last 30 min (dedupe).
3. If fresh: upsert `agent_health` row to `status='healthy'`.

Schedule it with pg_cron at `*/3 * * * *`. No edge function, no token, no LLM. Pure SQL.

**Why a separate `jessica_heartbeat` agent name (not just `jessica`)?**
The row `agent_name='jessica'` is what Jessica writes about herself. The row `agent_name='jessica_heartbeat'` is what Postgres writes about Jessica. If the two ever disagree — Jessica says she's fine but Postgres says she hasn't ticked — that itself is a useful signal that something weird is happening (maybe she's writing rows but not actually reasoning).

### Step 3 — Surface heartbeat in Harvey + the pipeline strip

Tiny additions on top of Claude's prompt:

- **Harvey:** the `agent_health` query in `copilot-chat` already picks up `jessica_heartbeat` for free (it selects all rows). His instruction to lead with degraded/failed agents covers it automatically.
- **Pipeline strip in `Copilot.tsx`:** Claude's `healthDot()` helper already keys on `agent_name`. Add one more dot or merge `jessica_heartbeat` into the existing Jessica dot — we'll use the *worst* of `jessica` and `jessica_heartbeat` so the dot turns red the moment either source flags trouble.

### Step 4 — Verify

1. `bunx vitest run` — all 88 tests still pass.
2. Manually invoke Jessica → confirm `agent_health` rows appear for `brain_trust`, `signal_engine`, `jessica`.
3. Wait 3+ minutes → confirm a `jessica_heartbeat` row appears (status `healthy`) from the pg_cron job.
4. Manually update `last_jessica_decision` to a 10-minute-old timestamp → within 3 min, `jessica_heartbeat` should flip to `failed` and an alert should appear.
5. Open Copilot → Harvey should lead with the heartbeat warning.
6. Restore the timestamp → Harvey goes quiet again.

---

## What NOT to change

- Don't touch doctrine, signal-engine, market-intelligence, or any other edge function logic.
- Don't add a third persona ("Norma" or similar) — Postgres + Jessica is enough. Defer until the watchdog logic genuinely needs LLM reasoning.
- Don't try to fix the Coinbase 4h `400` errors in this prompt — that's a separate fire (likely a granularity/limit param issue). The watchdog will at least make sure you *see* it next time.

---

## Technical details

**New migration files:**
- `YYYYMMDDHHMMSS_agent_health.sql` — table from Claude's prompt, minus the `auth.users` FK.
- `YYYYMMDDHHMMSS_jessica_heartbeat.sql` — defines `check_jessica_heartbeat()` SECURITY DEFINER function and schedules it via `cron.schedule('jessica-heartbeat', '*/3 * * * *', ...)`.

**Heartbeat dedupe:** the alert insert uses
```sql
WHERE NOT EXISTS (
  SELECT 1 FROM public.alerts
  WHERE user_id = v_user_id
    AND title = 'Jessica heartbeat lost'
    AND created_at > now() - interval '30 minutes'
)
```
so a sustained outage doesn't spam alerts every 3 minutes.

**Edge function changes:** exactly as in Claude's prompt — `jessica/index.ts` gets `checkAgentHealth()` + the pre-tick recovery block, `copilot-chat/index.ts` loads `agent_health` and gets the proactive-reporting instruction.

**Frontend changes:** `Copilot.tsx` gets the `agentHealth` state + `healthDot()` helper from Claude's prompt, with one tweak: the Jessica dot uses `Math.min(jessica.severity, jessica_heartbeat.severity)` (in terms of color tier) so either source can turn it red.

**RLS:** `agent_health` is read-only for users via `auth.uid() = user_id`. All writes go through service role from Jessica or the heartbeat function (which is SECURITY DEFINER). No user-side writes needed.
