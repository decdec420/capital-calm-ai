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

// ── Encoding helpers ──────────────────────────────────────────

function encodeB64url(obj: object): string {
  const json = JSON.stringify(obj);
  let bin = "";
  new TextEncoder().encode(json).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ── JWT signing ───────────────────────────────────────────────

/**
 * Build and sign a Coinbase Cloud JWT using ES256 (ECDSA P-256).
 * The JWT is valid for 60 seconds. Every call to the Coinbase API
 * must use a fresh JWT — do not cache.
 */
async function signCoinbaseJwt(creds: BrokerCredentials): Promise<string> {
  const keyBytes = pemToDer(creds.apiKeyPrivatePem);

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const now = Math.floor(Date.now() / 1000);
  // 16-char hex nonce (prevents replay)
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const header = { alg: "ES256", kid: creds.apiKeyName, typ: "JWT" };
  const payload = {
    iss: "coinbase-cloud",
    sub: creds.apiKeyName,
    nbf: now,
    exp: now + 60,
    nonce,
  };

  const sigInput = `${encodeB64url(header)}.${encodeB64url(payload)}`;

  // WebCrypto returns IEEE P1363 format (raw r||s, 64 bytes) — correct for JWT
  const sigBytes = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(sigInput),
  );

  const sigB64 = btoa(
    String.fromCharCode(...new Uint8Array(sigBytes)),
  ).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  return `${sigInput}.${sigB64}`;
}

// ── Credential retrieval ──────────────────────────────────────

/**
 * Fetch Coinbase API credentials from Supabase Vault.
 * Requires service-role admin client.
 * Throws if credentials are missing or Vault RPC fails.
 */
// deno-lint-ignore no-explicit-any
export async function getBrokerCredentials(admin: any): Promise<BrokerCredentials> {
  const { data, error } = await admin.rpc("get_coinbase_broker_credentials");
  if (error) {
    throw new Error(`[broker] Vault RPC failed: ${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.api_key_name || !row?.api_key_private_pem) {
    throw new Error(
      "[broker] Coinbase credentials not in Vault. " +
        "Insert 'coinbase_api_key_name' and 'coinbase_api_key_private_pem' — " +
        "see migration 20260427200000_broker_vault_setup.sql for instructions.",
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
    const jwt = await signCoinbaseJwt(creds);
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
  const jwt = await signCoinbaseJwt(creds);

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
  const jwt = await signCoinbaseJwt(creds);

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
