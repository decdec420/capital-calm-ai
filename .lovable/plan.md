# Let Max Trade More, Faster — Without Breaking the Safety Model

## The problem
Current doctrine = paper-mode safety harness:
- 5 trades/day max
- $1 per order, 1% risk
- Market scanned only every 5 minutes
- $2 daily loss = benched

This is correct for "don't blow up an $8 test account," but mathematically **cannot generate meaningful profit** and ignores fast crypto moves.

## The approach: Trading Profiles
Instead of one rigid doctrine, introduce **three named profiles** the user picks from. The doctrine invariants (kill switch, whitelist, no overriding guardrails *philosophy*) stay; only the *numbers* change per profile.

| Profile | Trades/day | Per-order | Risk/trade | Daily loss cap | Scan interval | Use case |
|---|---|---|---|---|---|---|
| **Sentinel** (current) | 5 | $1 | 1% | $2 | 5 min | Paper-prove the edge |
| **Active** (new default once armed) | 15 | $5 | 1.5% | $10 | 2 min | Real but cautious |
| **Aggressive** | 30 | $25 | 2% | $50 | 1 min | Funded + edge proven |

User can switch profiles from the Doctrine settings panel. **Live-arming still requires explicit consent** (that principle stays).

## Faster reaction time
Drop the cron from 5 min → configurable per profile (1, 2, or 5 min). This is the single biggest unlock — Max literally can't react to a candle he doesn't see.

For *true* split-second behavior we'd need a websocket stream (Coinbase pushes ticks live), but that's a bigger architectural change. The cron speedup gets us 80% of the benefit at 5% of the work.

## UI changes
1. **Doctrine page**: profile picker (3 cards), shows the active limits
2. **Status footer**: shows current profile name (`SENTINEL · 2/5`, `ACTIVE · 7/15`, etc.)
3. **Copilot context panel**: pulls limits from the active profile, not hardcoded
4. **Max's chat**: when he refuses a trade, the reason cites the profile (`"Active profile: 15/15 trades hit"` instead of generic `"daily cap"`)

## What stays locked (non-negotiable)
- Kill switch at $8 floor
- Symbol whitelist (BTC/ETH/SOL only)
- Stop-loss on every order
- Spread + stale-data gates
- Anti-tilt (loss-streak halt) — *still applies, scaled per profile*
- Live trading requires explicit arm

## Files to change

**Backend**
- `supabase/functions/_shared/doctrine.ts` — refactor to export profiles, not constants. Keep invariants but per-profile.
- `supabase/functions/_shared/snapshot.ts` — make scan interval read from active profile
- `supabase/functions/signal-engine/index.ts` — read limits from user's active profile
- New migration: add `active_profile` column to `system_state`, add cron jobs at 1m/2m intervals (gated by profile)

**Frontend**
- `src/lib/doctrine-constants.ts` — export profiles object
- New `src/components/trader/ProfilePicker.tsx`
- `src/components/trader/StatusFooter.tsx` — show profile name
- `src/pages/Copilot.tsx` — read from active profile
- `src/components/trader/DoctrineGuardrailGrid.tsx` — show active profile limits

**Tests**
- Update `doctrine.test.ts` to validate each profile's invariants independently
- Add `profile-switch.test.ts` to verify limits swap correctly

## What I'm NOT doing yet
- **Websocket live-tick streaming** — needs a separate plan (persistent Deno worker, Coinbase WS, reconnect logic). Worth doing as a follow-up once profiles prove out.
- **Auto-profile-promotion** (e.g., auto-upgrade Sentinel→Active after N green days) — premature; you should choose.
- **Removing the $8 kill switch** — never. That's the "don't lose your shirt" backstop.

## Open question
Want me to also raise the profile numbers above? I picked conservative defaults. If you want **Aggressive** to be e.g. 50 trades/day at $100 orders, say so now and I'll bake it in.
