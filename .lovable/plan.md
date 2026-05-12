# War Room triage & restructure

## The problem in one paragraph

War Room is currently used as a logbook where every Brain Trust tick writes 3 messages (one each from Hall, Dollar Bill, Mafee) per symbol, even when nothing changed. 88% of the 19K rows are routine "normal" intel from Mafee/Dollar Bill running on cron. The actual state those messages describe (momentum, funding, support/resistance, fear & greed, etc.) is *already* persisted in the `market_intelligence` table, which is upserted in the same code path. The messages are a duplicate. Meanwhile, the genuinely useful signal — Bobby directives, Spyros reviews, Hall regime shifts, extreme readings — gets buried in the noise.

Your hospital triage analogy fits exactly:
- **Vitals (routine intel):** belong on a chart that gets overwritten, not a new note every tick → `market_intelligence` table.
- **Notable events (regime change, extreme reading, directive, review):** belong in the War Room log forever → `war_room_messages`.

## What changes

### 1. Stop the noise at the source (`market-intelligence` edge function)

In `supabase/functions/market-intelligence/index.ts` (lines ~1043–1112), only post to `war_room_messages` when the message carries new information. Concretely:

- **Hall:** post only when `macro_bias` or `market_phase` *changes vs. previous row*, OR priority is `high` (strong_long / strong_short). Otherwise: silent — the state is in `market_intelligence` already.
- **Dollar Bill:** post only on extreme readings (`crowded_long`, `crowded_short`, F&G ≥80 or ≤20) OR when `funding_rate_signal` flips. Drop routine "neutral" posts entirely.
- **Mafee:** post only when momentum direction flips (1h or 4h up↔down) OR pattern context newly appears/disappears. Drop the "no clear pattern, low priority" posts.

Expected volume drop: ~95% (from ~170/hr to ~5–10/hr, only when something actually shifts).

### 2. Backfill cleanup (one-time)

Delete the existing routine noise so the table reflects the new policy retroactively. Keep everything high-signal forever, as you chose:

Delete rows where **all** of these are true:
- `message_type = 'intel'`
- `priority IN ('normal', 'low')`
- `from_agent IN ('mafee', 'dollar_bill', 'hall')`
- `acted_on = false`
- `created_at < now() - interval '24 hours'` (keep last 24h of context for debugging)

This will drop roughly 17,000 rows. The remaining ~2,000 rows are: all Bobby directives, the Spyros review, every `high`-priority Hall/Bill post, anything ever acted on, and the last day of routine posts as a transition buffer.

### 3. Ongoing retention: forever for signal, nightly sweep for stragglers

Add a daily cron (`pg_cron`, 04:00 UTC) that re-applies the same delete rule but with a `created_at < now() - interval '7 days'` cutoff. This catches any future "normal" intel that slips through (e.g. from a code regression), but keeps a week-long debug window. **High-priority items, directives, reviews, and `acted_on` messages are never deleted** — that's your "forever" answer.

### 4. War Room becomes what its name implies

After this, opening War Room shows the actual *events* — "Hall flipped bearish on SOL", "Bill flagged crowded_long on ETH", "Bobby directed Wendy to pause" — not a wall of vitals readouts. The dashboards that need current vitals already read from `market_intelligence`, so the UI doesn't lose anything.

## Technical details

**Files to change:**
- `supabase/functions/market-intelligence/index.ts` — add a `wasInteresting()` gate before each of the three `warRoomPosts.push(...)` calls. Compare `upsertPayload` against `prev` (already loaded in the function as `prev`) to detect actual changes.
- New migration: `pg_cron` job + helper SQL function `prune_war_room_routine_intel(cutoff_interval)` for the nightly sweep + immediate one-time call with `interval '24 hours'` to do the backfill cleanup.

**No schema changes** — existing columns (`priority`, `message_type`, `from_agent`, `acted_on`) already encode everything needed.

**No agent code other than `market-intelligence` needs to change.** Bobby, Spyros, Katrina, Jessica, post-trade-learn already post only on real events, not on a cron.

**Disk impact:** combined with the indexes added earlier today, the table goes from 22 MB / 19K rows growing at 4K/day, to ~2 MB / 2K rows growing at ~100/day. Effectively zero disk IO from this table going forward.

## Risk & rollback

Low risk. The deleted rows are duplicates of state held in `market_intelligence`. If anything ever needs the historical noise back, it can be reconstructed from the `market_intelligence` table's update history (or just not — that's the point). Rollback is reverting the `market-intelligence` function file; the deleted rows are gone, but they weren't carrying unique information.
