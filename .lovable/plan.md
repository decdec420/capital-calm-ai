## Hand-off cleanup: fix two correctness bugs + tidy cron

I audited the project against your hand-off prompt. Most of the work is already in place — the migrations are applied, the SQL function `realized_pnl_today(uuid)` exists in the DB, and `pg_cron` is already hitting `mark-to-market` every 15s. Two real bugs remain in the edge function code, plus a duplicate cron job to tidy.

---

### What's already done (no action needed)

- ✅ Migrations `20260421060000_diamond_tier_truth_pass.sql` and `20260421070000_server_authoritative_execution.sql` are applied.
- ✅ `public.realized_pnl_today(p_user_id uuid)` exists in the database with the correct definition.
- ✅ `pg_cron` job `mark-to-market-15s` is active (`*/15 * * * * *`) — but a second job named `mark-to-market` (schedule string `15 seconds`) is also active. Duplicate.
- ✅ `signal-engine-tick` cron is active (every 5 min).

### What still needs fixing

**BUG 1 — `supabase/functions/signal-engine/index.ts:331`**
Reads `acct.realized_pnl_today` from the `account_state` row, but that column does not exist, so the daily loss cap silently sees 0. Replace with an RPC call to the existing SQL function:

```ts
const { data: pnlToday } = await admin.rpc("realized_pnl_today", {
  p_user_id: userId,
});
const dailyRealizedPnlUsd = Number(pnlToday ?? 0);
```

**BUG 2 — `supabase/functions/mark-to-market/index.ts` (~line 420)**
When invoked under a user JWT, `runMarkToMarket(admin)` still scans every user's open trades. Fix:

- Add an optional `{ userId }: { userId?: string } = {}` arg to `runMarkToMarket`.
- When `userId` is set, append `.eq("user_id", userId)` to the open-trades query at line 87.
- In the user-JWT branch (line 420), call `runMarkToMarket(admin, { userId: userData.user.id })`.
- Cron path stays unscoped (global), unchanged.

**Cron tidy-up**
Two jobs are pointed at `mark-to-market`. Drop the older/duplicate one so the function isn't double-fired every 15s (extra cost, doubled heartbeat writes). Keep `mark-to-market-15s` (the canonical name from the hand-off prompt) and unschedule the duplicate `mark-to-market` job.

### Deploy

After the two code edits, redeploy the four functions called out in the hand-off:
- `signal-engine`
- `signal-decide`
- `mark-to-market`
- `trade-close`

### Verify

- Confirm `select * from cron.job` shows exactly one mark-to-market entry.
- Curl `mark-to-market` with a user JWT and confirm only that user's open trades update (response payload includes `userId`).
- Confirm `signal-engine` no longer returns `dailyRealizedPnlUsd: 0` when the user has closed losing trades today (check edge function logs).

### Out of scope (per your prompt)

Execution wiring / live orders / `EXECUTION_MODE` flag — left as paper.