## Root cause

The "Brain Trust" agent card on the Overview is **permanently** flagged stale within ~60s of every engine tick, even though the system is healthy. Live DB confirms briefs are ~1 minute old (fresh) and the engine snapshot is also recent — yet the UI says "Context stale — refresh."

The bug is a single-line threshold mismatch in `src/components/trader/AgentStatusRow.tsx`:

```ts
// line 140
const snapshotStale = isStale(snapshot ? new Date(snapshot.ranAt).getTime() : null);
```

`isStale()` in `src/hooks/useRelativeTime.ts` defaults to **60 000 ms (60 seconds)**. But:

- `signal-engine` cron runs every **~2 minutes** (visible in the edge logs: 06:48, 06:50, 06:52)
- The Market Intelligence panel even tells the user "refreshes every ~2 min"
- `SymbolStrip.tsx` already uses `isStale(ts, 5 * 60 * 1000)` — 5 minutes — for the same `ranAt` value

So the Brain Trust card flips to "stale" roughly 60 seconds after every engine tick and only flips back for a few seconds at the next tick. It's not a backend problem — the data is fine. The threshold is just wrong for the cron cadence.

## Secondary observation (not part of this fix, just context)

The Brain Trust card is keyed off `snapshot.ranAt` (engine snapshot) rather than `market_intelligence.recent_momentum_at` (the actual Brain Trust output). They're correlated but conceptually different. The Market Intelligence panel uses `recent_momentum_at` with a 75-min threshold and is showing healthy. Switching the Brain Trust card to read from the same source would be more accurate, but it's a larger change and not required to stop the false alarm.

## The fix

Change one line in `src/components/trader/AgentStatusRow.tsx`:

```ts
// before
const snapshotStale = isStale(snapshot ? new Date(snapshot.ranAt).getTime() : null);

// after — match SymbolStrip's threshold and the engine's 2-min cadence
const SNAPSHOT_STALE_MS = 5 * 60 * 1000; // 5 minutes; engine cron is ~2 min
const snapshotStale = isStale(snapshot ? new Date(snapshot.ranAt).getTime() : null, SNAPSHOT_STALE_MS);
```

That's it. No backend changes, no migration, no edge function changes.

## Validation

After the change:
- With a snapshot <5 min old → Brain Trust shows the regime label and "active" status (green).
- Only flips to "alert / Context stale — refresh" if the engine actually misses 2+ ticks in a row, which is the real failure case worth surfacing.
- Visible immediately on `/` — no refresh of the page required beyond Vite HMR.

## Scope guard

Touches one file, one line of logic. Does not change:
- `useRelativeTime.ts` default (other callers depend on 60s)
- Any backend behavior or cron cadence
- The Market Intelligence panel's own freshness rules