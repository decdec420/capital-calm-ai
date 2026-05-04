## Why Brain Trust shows 561m staleness

The `market-intelligence-2m` cron job is firing every 2 minutes and succeeding. But inside `supabase/functions/market-intelligence/index.ts` (line 1115-1119), the cron sweep only picks up users whose `system_state.bot = 'running'`:

```ts
const { data: users } = await admin
  .from("system_state").select("user_id").eq("bot", "running");
```

Your account is currently `bot = 'paused'` (kill-switch is disarmed, but the bot itself is paused). So the cron skips your user every tick. The last fresh row in `market_intelligence` is from **06:16 UTC** — ~9h25m ago, which lines up with the 561-minute staleness banner.

This is a real correctness bug, not a UI glitch: a paused bot still needs fresh market intelligence so the operator (you) can decide *when* to unpause. Right now the data only refreshes while trading, which is exactly backward — you need the freshest read precisely when you're flat.

## The fix

**One change**, two lines, in `supabase/functions/market-intelligence/index.ts`:

Replace the `bot = 'running'` filter with one that includes paused bots too, but excludes accounts that are fully kill-switched (those are an explicit "stop everything" signal):

```ts
const { data: users } = await admin
  .from("system_state")
  .select("user_id, bot, kill_switch_engaged")
  .in("bot", ["running", "paused"])
  .eq("kill_switch_engaged", false);
userIds = (users ?? []).map((u) => u.user_id);
```

Rationale:
- `running` — obviously needs fresh intel.
- `paused` — operator-idle; still needs fresh intel for the unpause decision and for the war-room narrative.
- `kill_switch_engaged = true` — explicit halt; no point burning Lovable AI tokens.

No schema change. No frontend change. The `market-intelligence-2m` cron will start refreshing your row within 2 minutes of deploy, and the staleness banner will drop to <2m.

## Out of scope

- The `activate-doctrine-changes` `cors is not defined` error spamming the logs. That's a separate bug (function references `cors` without importing it). Happy to fix in a follow-up — say the word.
- The `DialogContent`/`DialogTitle` a11y warnings on the current view. Cosmetic.
- No changes to freshness thresholds, expert gating, or sizing.

## Verification after deploy

1. Wait ~2 minutes.
2. `select symbol, now() - generated_at as age from market_intelligence;` — all three should be <2m.
3. Brain Trust banner on Copilot drops to "fresh".
