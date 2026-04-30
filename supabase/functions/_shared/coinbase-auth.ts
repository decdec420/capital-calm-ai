const CB_BASE = "https://api.coinbase.com";

function stripPem(pem: string): string {
  return pem
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s/g, "");
}

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function sec1ToPkcs8Pem(sec1Pem: string): string {
  const sec1 = b64ToBytes(stripPem(sec1Pem));
  let priv: Uint8Array | null = null;
  for (let i = 0; i < sec1.length - 33; i++) {
    if (sec1[i] === 0x04 && sec1[i + 1] === 0x20) {
      priv = sec1.slice(i + 2, i + 2 + 32);
      break;
    }
  }
  if (!priv) throw new Error("Could not parse SEC1 private key — expected 32-byte P-256 scalar");

  const ecPrivateKey = new Uint8Array([
    0x30, 0x25,
    0x02, 0x01, 0x01,
    0x04, 0x20, ...priv,
    0xa1, 0x00,
  ]);

  const algId = new Uint8Array([
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
  ]);

  const inner = new Uint8Array([
    0x02, 0x01, 0x00,
    ...algId,
    0x04, ecPrivateKey.length, ...ecPrivateKey,
  ]);

  const pkcs8 = new Uint8Array([0x30, 0x82, (inner.length >> 8) & 0xff, inner.length & 0xff, ...inner]);
  const b64 = bytesToB64(pkcs8);
  const wrapped = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
}

function encodeB64url(obj: object): string {
  const json = JSON.stringify(obj);
  let bin = "";
  new TextEncoder().encode(json).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pemToDer(pem: string): Uint8Array {
  return b64ToBytes(stripPem(pem));
}

export function normalizeCoinbasePrivateKeyPem(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("BEGIN PRIVATE KEY")) {
    return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  }
  if (trimmed.includes("BEGIN EC PRIVATE KEY")) {
    return sec1ToPkcs8Pem(trimmed);
  }
  throw new Error(
    "Private key must be PEM with -----BEGIN PRIVATE KEY----- or -----BEGIN EC PRIVATE KEY-----",
  );
}

export async function signCoinbaseJwt(keyName: string, privatePem: string): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privatePem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const now = Math.floor(Date.now() / 1000);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const header = { alg: "ES256", kid: keyName, typ: "JWT" };
  const payload = {
    iss: "coinbase-cloud",
    sub: keyName,
    nbf: now,
    exp: now + 60,
    nonce,
  };

  const sigInput = `${encodeB64url(header)}.${encodeB64url(payload)}`;
  const sigBytes = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(sigInput),
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${sigInput}.${sigB64}`;
}

export async function probeCoinbaseAccounts(
  keyName: string,
  privatePem: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  try {
    const jwt = await signCoinbaseJwt(keyName, privatePem);
    const r = await fetch(`${CB_BASE}/api/v3/brokerage/accounts?limit=1`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    if (r.ok) {
      await r.text();
      return { ok: true };
    }

    const txt = await r.text();
    return { ok: false, status: r.status, error: txt.slice(0, 400) };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
