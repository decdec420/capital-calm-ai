# capital-calm-ai — Operator Runbooks

> **Who this is for:** The operator running the live trading desk.  
> These are step-by-step procedures for the scenarios most likely to need fast, confident action at 3am.

---

## 1. Ghost Trade Recovery

**Symptom:** A Coinbase position exists (visible in the Coinbase dashboard) with no matching `open` row in the `trades` table, or a `broker_pending` / `broker_failed` row that never promoted to `open`.

**Why it happens:** The two-phase write pattern pre-inserts a `broker_pending` row before calling the broker. If the Deno isolate crashed between the broker fill and the DB `UPDATE`, the position is real but the row is stuck.

**Steps:**

1. **Find the orphaned row** in Supabase Table Editor → `trades` filtered by `status = 'broker_pending'` or `status = 'broker_failed'`. Note the `broker_order_id` (the Coinbase `client_order_id`).

2. **Confirm the Coinbase fill** in the Coinbase Advanced Trade dashboard. Search by Order ID. Copy the actual `filled_size`, `average_filled_price`, and `order_id`.

3. **Promote the row manually** via Supabase SQL Editor:
   ```sql
   UPDATE public.trades
   SET
     status        = 'open',
     entry_price   = <average_filled_price>,
     size          = <filled_size>,
     broker_order_id = '<coinbase_order_id>'
   WHERE id = '<trade_row_id>'
     AND user_id = '<your_user_id>';
   ```

4. **Trigger MTM** — the mark-to-market cron runs every 15 seconds and will pick up the `open` row on the next tick. Wait 30 seconds and confirm `current_price`, `unrealized_pnl`, and stop-loss monitoring are active.

5. **Reconcile account balance** — if `account_state.cash` is wrong, update it:
   ```sql
   UPDATE public.account_state
   SET cash = cash - <filled_quote_size_usd>
   WHERE user_id = '<your_user_id>';
   ```

6. **Log the event** in the journal with kind `postmortem` and tag `ghost_trade_recovery`.

---

## 2. Kill-Switch Emergency Procedure

**Goal:** Halt all autonomous trading activity in under 10 seconds from any page.

**Fast path (UI):**

1. Click the **Kill Switch** toggle in the top-right status bar of any page. It turns red immediately.
2. The kill switch is enforced in: Jessica (skips tick), signal-engine (blocks auto-execute), and mark-to-market (skips close attempts).

**If the UI is unreachable:**

```sql
UPDATE public.system_state
SET kill_switch_engaged = true
WHERE user_id = '<your_user_id>';
```

**To verify it's active:**

```sql
SELECT kill_switch_engaged, bot, last_heartbeat
FROM public.system_state
WHERE user_id = '<your_user_id>';
```

**To re-enable trading after the incident is resolved:**

1. Confirm no orphaned `broker_pending` rows.
2. Confirm `account_state.cash` matches Coinbase available balance.
3. Toggle the kill switch off in the UI. The system does **not** auto-resume — you must explicitly set `bot = 'running'` after.

---

## 3. Coinbase API Key Rotation

**When:** Key is compromised, expired, or you are rotating as part of scheduled key hygiene.

**Steps:**

1. **Generate a new key** in Coinbase Advanced Trade → API → New API Key. Select `trade` and `view` scopes only. Download the PEM file.

2. **Convert to PKCS8** if Coinbase provided SEC1 format:
   ```bash
   openssl pkcs8 -topk8 -nocrypt -in key.pem -out key_pkcs8.pem
   ```

3. **Update Vault** via Supabase SQL Editor (service-role access required):
   ```sql
   -- Replace existing secrets
   SELECT vault.update_secret('<secret_id_for_api_key_name>',   'organizations/xxx/apiKeys/yyy');
   SELECT vault.update_secret('<secret_id_for_api_key_private_pem>', '<pem_contents_single_line>');
   ```
   > Find the `secret_id` values by running: `SELECT id, name FROM vault.secrets WHERE name LIKE 'coinbase%';`

4. **Test** with a manual `broker-execute` call via Supabase Dashboard → Edge Functions → broker-execute → Test. Use `{ "action": "buy", "productId": "BTC-USD", "quoteSize": "0.01" }` with service-role Authorization header.

5. **Revoke the old key** in the Coinbase dashboard.

6. **Log the rotation** in `system_events` or journal with event type `key_rotation`.

---

## 4. Supabase Service-Role Key Rotation

**When:** Key is compromised or you are rotating credentials.

**⚠ This key is used by ALL edge functions. Coordinate the update atomically.**

**Steps:**

1. **Generate a new service-role key** in Supabase Dashboard → Project Settings → API.

2. **Update ALL edge function secrets simultaneously** in Supabase Dashboard → Edge Functions → Manage secrets:
   - `SUPABASE_SERVICE_ROLE_KEY` → new key

3. **Verify** by triggering a Jessica cron invocation (Dashboard → Edge Functions → jessica → Run) and confirming it completes without auth errors in the logs.

4. **Revoke the old key** in Supabase settings.

5. If you have the old key stored anywhere else (local `.env`, CI secrets), rotate those too.

---

## 5. Graduated Live-Mode Rollout

**Goal:** Move from paper trading to live trading with controlled capital exposure.

### Prerequisites (must all be true before enabling live mode)

- [ ] `acknowledge_live_money` has been signed (one-time UI acknowledgment)
- [ ] Coinbase API key is in Vault and tested successfully (Runbook 3)
- [ ] `account_state.equity` and `.cash` match Coinbase available balance
- [ ] No `broker_pending` or `broker_failed` rows exist
- [ ] Kill switch is off, bot is running
- [ ] `doctrine_settings.max_order_usd` is set to the Week 1 cap (see below)

### Rollout schedule

| Week | `max_order_usd` | `daily_auto_execute_cap_usd` | Action |
|------|-----------------|------------------------------|--------|
| 1    | $0.25           | $0.50                        | Enable live mode, monitor every fill |
| 2    | $0.50           | $1.00                        | If ≥3 clean fills with no ghost trades |
| 3    | $1.00           | $2.00                        | If Week 2 drawdown < 5% |
| 4+   | Increase 2× per week | Scale proportionally   | Continue only if reconciliation passes |

### Reconciliation checkpoint (run before each step-up)

```sql
-- Confirm all fills have matching DB records
SELECT COUNT(*) FROM public.trades
WHERE status = 'broker_pending' AND created_at > NOW() - INTERVAL '7 days';
-- Must be 0

-- Confirm account balance matches Coinbase
SELECT equity, cash FROM public.account_state WHERE user_id = '<your_user_id>';
-- Compare to Coinbase "Available to Trade" balance — should be within $0.02
```

### Rollback trigger

Immediately revert to paper mode (`system_state.mode = 'paper'`) if any of:
- A ghost trade occurs (any `broker_pending` row older than 10 minutes)
- Realized drawdown exceeds 10% of starting equity in any 7-day window
- Coinbase API errors exceed 3 in one hour
- Any unexpected order appears in Coinbase that has no matching `trades` row
