# Live Execution Sprint — Claude Implementation Notes

## What Was Built

This sprint adds real Coinbase broker integration to every execution path.
Previously the system was 100% paper — "live mode" just wrote DB records.
Now when `live_trading_enabled = true`, all four execution paths place real orders.

---

## Files Created

### `supabase/migrations/20260427200000_broker_vault_setup.sql`
Creates `get_coinbase_broker_credentials()` — a SECURITY DEFINER function
that reads `coinbase_api_key_name` and `coinbase_api_key_private_pem` from
`vault.decrypted_secrets`. Only callable by service_role.

### `supabase/migrations/20260427200001_trades_broker_order_ids.sql`
Adds `broker_order_id` (opening BUY) and `broker_close_order_id` (closing SELL)
to the `trades` table. Null in paper mode; populated with Coinbase order IDs in live.

### `supabase/functions/_shared/broker.ts`
The Coinbase Advanced Trade API client. Handles:
- ES256 JWT signing (ECDSA P-256, `crypto.subtle`)
- `placeMarketBuy(creds, productId, quoteSize, clientOrderId)` — BUY by quote (USD)
- `placeMarketSell(creds, productId, baseSize, clientOrderId)` — SELL by base qty
- `waitForFill(...)` — polls `GET /api/v3/brokerage/orders/historical/{id}` until FILLED
- `getBrokerCredentials(admin)` — reads from Vault via `get_coinbase_broker_credentials()` RPC

**Fail-safe contract:** every function throws on any error. Callers never write
DB records on broker failure, preventing ghost trades.

### `supabase/functions/broker-execute/index.ts`
Standalone HTTP endpoint for manual testing. Requires service-role Bearer token.
Body: `{ action: "buy"|"sell", productId, quoteSize?, baseSize?, clientOrderId? }`

---

## Files Modified

### `supabase/functions/_shared/reasons.ts`
Added `BROKER_ORDER_FAILED` gate code.

### `supabase/functions/signal-decide/index.ts`
On **approve**: if `live_trading_enabled`, calls `placeMarketBuy` before DB insert.
Uses actual fill price as `entry_price`. Returns 502 on broker failure (no DB write).

### `supabase/functions/trade-close/index.ts`
Checks `live_trading_enabled` from system_state. In live mode, calls `placeMarketSell`
before DB close update. Uses actual fill price as `exit_price`. Returns 502 on failure.

### `supabase/functions/mark-to-market/index.ts`
Builds a per-user `liveUserIds` set. For live users:
- On **tp1_fill**: optimistic lock (`status='closing'`), place partial SELL, then reset to 'open' with updated runner size
- On **stop_hit / tp2_hit**: optimistic lock, place full SELL, then complete close update
- On broker failure: reverts lock to 'open' so next tick can retry. No ghost trade.

### `supabase/functions/signal-engine/index.ts`
In the `autoApprove` block: if `liveEnabled`, calls `placeMarketBuy` before `trades.insert()`.
Uses actual fill price and filled size. On broker failure: returns early with `BROKER_ORDER_FAILED`
gate reason and leaves signal as "proposed" for manual operator approval.

---

## Operator Setup (Run Once)

### Step 1 — Generate Coinbase Advanced Trade API Key
1. Go to Coinbase Advanced → Settings → API → New API Key
2. Select scopes: **view** + **trade**
3. Download the private key PEM

### Step 2 — Convert key to PKCS8 format
The Web Crypto API requires PKCS8, not SEC1:
```bash
openssl pkcs8 -topk8 -nocrypt \
  -in coinbase_key.pem \
  -out coinbase_key_pkcs8.pem
```
The output will start with `-----BEGIN PRIVATE KEY-----`.

### Step 3 — Store credentials in Vault
Run in Supabase SQL editor (replace the placeholder values):
```sql
SELECT vault.create_secret(
  'organizations/{org_id}/apiKeys/{key_id}',
  'coinbase_api_key_name',
  'Coinbase Advanced Trade API key name'
);

SELECT vault.create_secret(
  '-----BEGIN PRIVATE KEY-----
<your-base64-key-content>
-----END PRIVATE KEY-----',
  'coinbase_api_key_private_pem',
  'Coinbase Advanced Trade EC private key (PKCS8 PEM)'
);
```

### Step 4 — Verify
```sql
SELECT name, created_at FROM vault.secrets
WHERE name IN ('coinbase_api_key_name', 'coinbase_api_key_private_pem');
```

---

## Dry-Run Verification

1. **`bunx vitest run`** — all existing tests pass (no test changes needed; broker is guarded by `liveEnabled`).

2. **Smoke-test broker-execute** (requires service-role key):
   ```bash
   curl -X POST https://<project>.supabase.co/functions/v1/broker-execute \
     -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
     -H "Content-Type: application/json" \
     -d '{"action":"buy","productId":"BTC-USD","quoteSize":"1.00"}'
   ```
   Expect: `{"ok":true,"fill":{"fillPrice":...,"filledBaseSize":...}}`

3. **Paper mode unchanged**: with `live_trading_enabled = false`, all execution paths
   use the ticker price + DB writes as before. No broker calls.

4. **Live approve flow**: set `live_trading_enabled = true` (requires `live_money_acknowledged_at`
   from the acknowledgment gate). Approve a pending signal. Confirm:
   - `trades.broker_order_id` is populated
   - `trades.entry_price` matches the actual fill price
   - Corresponding order appears in Coinbase Advanced dashboard

5. **Live close flow**: close a live trade via `trade-close`. Confirm:
   - `trades.broker_close_order_id` is populated
   - `trades.exit_price` matches the fill price

---

## What Comes Next

- **48-hour paper-dry-run**: run with `live_trading_enabled = false` and broker credentials
  loaded but not called — verify all paper signals, approvals, closes work as before.
- **First live order**: flip `live_trading_enabled = true`. The doctrine hard cap
  (`maxOrderUsdHardCap: $1`) limits real-money exposure on every order.
- **Kill switch**: if anything looks wrong, flip the kill switch in the UI (`< 2 seconds`).
