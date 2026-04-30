// ============================================================
// Coinbase Advanced Trade API client — broker.ts
// ------------------------------------------------------------
// Authoritative. Shared by every edge function that places or
// closes real orders in live mode.
//
// FAIL-SAFE CONTRACT:
//   Every exported function THROWS on any failure.
//   Callers must NOT write the DB trade record if this throws.
//   This prevents ghost trades (DB says "open", no real position).
//
// KEY FORMAT:
//   The private key stored in Vault must be PKCS8 PEM format
//   (-----BEGIN PRIVATE KEY-----). If Coinbase provided SEC1
//   (-----BEGIN EC PRIVATE KEY-----), convert first:
//     openssl pkcs8 -topk8 -nocrypt -in key.pem -out key_pkcs8.pem
// ============================================================

import { signCoinbaseJwt } from "./coinbase-auth.ts";

const CB_BASE = "https://api.coinbase.com";

// ── Types ─────────────────────────────────────────────────────

export interface BrokerCredentials {
  /** organizations/{org_id}/apiKeys/{key_id} */
  apiKeyName: string;
  /** EC P-256 private key in PKCS8 PEM format */
  apiKeyPrivatePem: string;
}

export interface BrokerFill {
  orderId: string;
  clientOrderId: string;
  side: "BUY" | "SELL";
  productId: string;
  /** Average fill price in USD */
  fillPrice: number;
  /** Filled size in base asset (e.g. BTC) */
  filledBaseSize: number;
  /** Total quote spent/received in USD */
  filledQuoteSize: number;
  status: string;
}

// ── Credential retrieval ──────────────────────────────────────

/**
 * Fetch Coinbase API credentials.
 * Checks env vars first (COINBASE_API_KEY_NAME + COINBASE_API_KEY_PRIVATE_PEM),
 * then falls back to Supabase Vault RPC for legacy setups.
 */
// deno-lint-ignore no-explicit-any
export async function getBrokerCredentials(admin: any): Promise<BrokerCredentials> {
  // Primary: env vars set in Lovable Cloud → Secrets (or Supabase Edge Function secrets)
  const envKeyName = Deno.env.get("COINBASE_API_KEY_NAME");
  const envKeyPem = Deno.env.get("COINBASE_API_KEY_PRIVATE_PEM");
  if (envKeyName && envKeyPem) {
    return { apiKeyName: envKeyName, apiKeyPrivatePem: envKeyPem };
  }

  // Fallback: Supabase Vault RPC (legacy)
  const { data, error } = await admin.rpc("get_coinbase_broker_credentials");
  if (error) {
    throw new Error(`[broker] Vault RPC failed: ${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.api_key_name || !row?.api_key_private_pem) {
    throw new Error(
      "[broker] Coinbase credentials not found. " +
        "Set COINBASE_API_KEY_NAME and COINBASE_API_KEY_PRIVATE_PEM in Lovable Cloud → Secrets.",
    );
  }
  return {
    apiKeyName: row.api_key_name,
    apiKeyPrivatePem: row.api_key_private_pem,
  };
}

// ── Order polling ─────────────────────────────────────────────

/**
 * Poll until the order reaches FILLED or CANCELLED status.
 * Market IOC orders on liquid pairs (BTC/ETH/SOL) fill in < 1s.
 * Throws if the order is not filled within timeoutMs.
 */
async function waitForFill(
  creds: BrokerCredentials,
  orderId: string,
  timeoutMs = 6_000,
): Promise<BrokerFill> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const jwt = await signCoinbaseJwt(creds.apiKeyName, creds.apiKeyPrivatePem);
    const r = await fetch(
      `${CB_BASE}/api/v3/brokerage/orders/historical/${orderId}`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    );

    if (!r.ok) {
      throw new Error(`[broker] Order status fetch failed (${r.status}): ${await r.text()}`);
    }

    const body = await r.json();
    const order = body.order ?? body;

    if (order.status === "FILLED" || order.status === "CANCELLED") {
      if (order.status === "CANCELLED") {
        throw new Error(
          `[broker] Order ${orderId} was CANCELLED — no fill. ` +
            "Check spread/liquidity or reduce quote_size below minimum.",
        );
      }
      return {
        orderId: order.order_id,
        clientOrderId: order.client_order_id ?? "",
        side: order.side,
        productId: order.product_id,
        fillPrice: Number(order.average_filled_price ?? 0),
        filledBaseSize: Number(order.filled_size ?? 0),
        filledQuoteSize: Number(order.total_value_after_fees ?? order.filled_value ?? 0),
        status: order.status,
      };
    }

    // Not yet filled — wait 300ms and retry
    await new Promise((res) => setTimeout(res, 300));
  }

  throw new Error(
    `[broker] Order ${orderId} did not fill within ${timeoutMs}ms. ` +
      "Check Coinbase dashboard — position may be open without a DB record.",
  );
}

// ── Public order API ──────────────────────────────────────────

/**
 * Place a market BUY order spending exactly `quoteSize` USD.
 * Use for opening a position (the dollar amount from sizing).
 *
 * @param creds       Coinbase API credentials from Vault
 * @param productId   e.g. "BTC-USD"
 * @param quoteSize   USD amount to spend, e.g. "1.00" (doctrine max)
 * @param clientOrderId  Caller-supplied idempotency key (UUID)
 */
export async function placeMarketBuy(
  creds: BrokerCredentials,
  productId: string,
  quoteSize: string,
  clientOrderId: string,
): Promise<BrokerFill> {
  const jwt = await signCoinbaseJwt(creds.apiKeyName, creds.apiKeyPrivatePem);

  const orderBody = {
    client_order_id: clientOrderId,
    product_id: productId,
    side: "BUY",
    order_configuration: {
      market_market_ioc: { quote_size: quoteSize },
    },
  };

  const r = await fetch(`${CB_BASE}/api/v3/brokerage/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(orderBody),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`[broker] BUY order HTTP ${r.status}: ${errText}`);
  }

  const resp = await r.json();
  if (!resp.success) {
    const msg = resp.error_response?.message ?? resp.error ?? JSON.stringify(resp);
    throw new Error(`[broker] BUY order rejected by Coinbase: ${msg}`);
  }

  const orderId: string = resp.success_response.order_id;
  console.log(`[broker] BUY order placed ${productId} $${quoteSize} — orderId ${orderId}`);

  return waitForFill(creds, orderId);
}

/**
 * Place a market SELL order for exactly `baseSize` units.
 * Use for closing a position (sell the exact size from the trades row).
 *
 * @param creds       Coinbase API credentials from Vault
 * @param productId   e.g. "BTC-USD"
 * @param baseSize    Quantity of base asset to sell, e.g. "0.00001234"
 * @param clientOrderId  Caller-supplied idempotency key (UUID)
 */
export async function placeMarketSell(
  creds: BrokerCredentials,
  productId: string,
  baseSize: string,
  clientOrderId: string,
): Promise<BrokerFill> {
  const jwt = await signCoinbaseJwt(creds.apiKeyName, creds.apiKeyPrivatePem);

  const orderBody = {
    client_order_id: clientOrderId,
    product_id: productId,
    side: "SELL",
    order_configuration: {
      market_market_ioc: { base_size: baseSize },
    },
  };

  const r = await fetch(`${CB_BASE}/api/v3/brokerage/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(orderBody),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`[broker] SELL order HTTP ${r.status}: ${errText}`);
  }

  const resp = await r.json();
  if (!resp.success) {
    const msg = resp.error_response?.message ?? resp.error ?? JSON.stringify(resp);
    throw new Error(`[broker] SELL order rejected by Coinbase: ${msg}`);
  }

  const orderId: string = resp.success_response.order_id;
  console.log(
    `[broker] SELL order placed ${productId} ${baseSize} units — orderId ${orderId}`,
  );

  return waitForFill(creds, orderId);
}
