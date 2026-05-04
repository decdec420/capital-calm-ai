# Fix the system_events 404s (and the disappearing chat popup)

## Root cause

The codebase reads from and writes to a `system_events` table in many places — Bobby (Jessica), Katrina, Chuck, desk-tools, the realtime subscription provider, `useSystemState`, and `DoctrineProposalBanner` — but **the table does not exist in the database**. I confirmed this:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name='system_events';
-- returns 0 rows
```

So every call returns PostgREST 404 (`PGRST205`). The frontend ones are noisy in the console; the edge-function ones are wrapped in try/catch and silently lose every audit event Bobby/Katrina/Wags try to write.

This also explains the **chat popup that "appeared then disappeared"**: that's `DoctrineProposalBanner` mounting, hitting the 404, and then calling `setChanges([])`, which unmounts the banner. The "kill-switch is correct/disarmed" message you saw was the banner briefly trying to render a recently-applied doctrine change before the query failed. (Killswitch state itself is fine — that's read from `system_state` and works.)

## Plan

### 1. Create the `system_events` table

A simple append-only event log keyed by user.

Columns:
- `id uuid pk default gen_random_uuid()`
- `user_id uuid not null references auth.users(id) on delete cascade`
- `event_type text not null` (e.g. `doctrine_change`, `bobby_decision`, `state_changed`, `signal_engine_stuck`, `katrina_recommendation`)
- `actor text not null` (e.g. `operator`, `jessica_autonomous`, `katrina`, `wags`)
- `payload jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`

Indexes:
- `(user_id, created_at desc)` — primary access pattern
- `(user_id, event_type, created_at desc)` — for the doctrine-banner / decision-history filters

Realtime: add to `supabase_realtime` publication, since `useRealtimeSubscriptions` already lists `system_events` as a watched table.

### 2. RLS

- Enable RLS.
- `SELECT`: user can read their own rows (`auth.uid() = user_id`).
- `INSERT` from authenticated client: user can insert their own rows (used by `useSystemState` for `state_changed`).
- No `UPDATE` / `DELETE` policies → table is effectively append-only for clients.
- Service role (used by all edge functions: jessica, katrina, chuck, desk-tools) bypasses RLS as usual.

### 3. No code changes required

The 9 existing call sites already match this schema (`event_type`, `actor`, `payload`, `user_id`, `created_at`), and the frontend already handles 404s gracefully. Once the table exists:
- The 404 spam in DevTools stops.
- `DoctrineProposalBanner` stops flickering — it'll only render when there's an actual recent applied doctrine change.
- Bobby finally has a real behavioral memory (recent autonomy changes, kill-switch trips, his own past decisions in the last 24h) instead of always seeing an empty list at jessica/index.ts:357.
- Chuck's market-brief generator (line 87) starts including real recent system events.

### 4. Verify

After the migration:
- Reload `/overview` and confirm no `system_events` 404 in the network tab.
- Toggle the kill-switch once and confirm a row lands in `system_events` with `event_type='state_changed'`.
- Wait for the next Jessica tick and confirm a `bobby_decision` row appears.

## Out of scope

- The React `forwardRef` warnings on `/auth` (`Auth` and `PasswordInput`) are unrelated cosmetic dev-only warnings. Happy to fix them in a follow-up if you want, but they don't affect behavior.
- No changes to live trading, top-up flow, or doctrine logic.
