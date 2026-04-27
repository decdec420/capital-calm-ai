// ============================================================
// broker-execute — standalone order placement endpoint
// ------------------------------------------------------------
// HTTP wrapper around _shared/broker.ts for manual testing
// and operator-initiated orders outside the normal signal flow.
//
// Auth: service-role JWT required (not user JWT) — this function
// is never called from the browser. It is called by other edge
// functions internally or by operators via Supabase dashboard.
//
// Request body:
//   { action: "buy" | "sell", productId: string,
//     quoteSize?: string,   // for buy:  USD amount e.g. "1.00"
//     baseSize?: string,    // for sell: asset qty e.g. "0.00001234"
//     clientOrderId?: string }   // optional idempotency key
//
// Response:
//   { ok: true, fill: BrokerFill }
//   { ok: false, error: string }
// ============================================================

import {
  getBrokerCredentials,
  placeMarketBuy,
  placeMarketSell,
} from "../_shared/broker.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // This endpoint requires the service-role key — not accessible to users.
    const authHeader = req.headers.get("Authorization") ?? "";
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!bearer || bearer !== SERVICE_KEY) {
      return json({ ok: false, error: "Service-role key required" }, 401);
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const { createClient } = await import(
      "https://esm.sh/@supabase/supabase-js@2.45.0"
    );
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const body = await req.json().catch(() => ({}));
    const { action, productId, quoteSize, baseSize } = body as {
      action?: string;
      productId?: string;
      quoteSize?: string;
      baseSize?: string;
      clientOrderId?: string;
    };
    const clientOrderId: string = body.clientOrderId ?? crypto.randomUUID();

    if (!action || !["buy", "sell"].includes(action)) {
      return json({ ok: false, error: "action must be 'buy' or 'sell'" }, 400);
    }
    if (!productId) {
      return json({ ok: false, error: "productId required (e.g. 'BTC-USD')" }, 400);
    }
    if (action === "buy" && !quoteSize) {
      return json({ ok: false, error: "quoteSize required for buy (e.g. '1.00')" }, 400);
    }
    if (action === "sell" && !baseSize) {
      return json({ ok: false, error: "baseSize required for sell (e.g. '0.00001234')" }, 400);
    }

    const creds = await getBrokerCredentials(admin);

    const fill = action === "buy"
      ? await placeMarketBuy(creds, productId, quoteSize!, clientOrderId)
      : await placeMarketSell(creds, productId, baseSize!, clientOrderId);

    console.log(
      `[broker-execute] ${action.toUpperCase()} ${productId} — ` +
        `fillPrice $${fill.fillPrice} filledBase ${fill.filledBaseSize}`,
    );

    return json({ ok: true, fill });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[broker-execute] error:", message);
    return json({ ok: false, error: message }, 502);
  }
});
