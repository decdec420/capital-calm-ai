-- ============================================================
-- Broker Vault Setup (P4-E)
-- ------------------------------------------------------------
-- Creates DB helper function to retrieve Coinbase Advanced Trade
-- API credentials from Supabase Vault (pgsodium-encrypted).
-- Follows the same pattern as get_signal_engine_cron_token() etc.
--
-- OPERATOR SETUP (run once after deploying this migration):
--
--   1. Generate a Coinbase Advanced Trade API key:
--      Dashboard → API → Keys → Create API Key
--      Select scopes: trade (view + trade)
--
--   2. Coinbase delivers two values:
--        API Key Name:  organizations/{org_id}/apiKeys/{key_id}
--        Private Key:   PEM file starting with "-----BEGIN EC PRIVATE KEY-----"
--
--   3. Convert the private key to PKCS8 format (required by Web Crypto):
--        openssl pkcs8 -topk8 -nocrypt \
--          -in coinbase_key.pem \
--          -out coinbase_key_pkcs8.pem
--      The output starts with "-----BEGIN PRIVATE KEY-----".
--
--   4. Store both in Vault (run in Supabase SQL editor):
--        SELECT vault.create_secret(
--          '<api-key-name>',
--          'coinbase_api_key_name',
--          'Coinbase Advanced Trade API key name'
--        );
--        SELECT vault.create_secret(
--          '<multi-line-pkcs8-pem-including-headers>',
--          'coinbase_api_key_private_pem',
--          'Coinbase Advanced Trade EC private key (PKCS8 PEM)'
--        );
--
--   5. Verify (should return two rows):
--        SELECT name FROM vault.secrets
--        WHERE name IN ('coinbase_api_key_name', 'coinbase_api_key_private_pem');
--
-- ROTATING KEYS: Delete the old secret and create a new one:
--   SELECT vault.delete_secret(
--     (SELECT id FROM vault.secrets WHERE name = 'coinbase_api_key_name')
--   );
--   then re-run step 4 above.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_coinbase_broker_credentials()
RETURNS TABLE(api_key_name text, api_key_private_pem text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT decrypted_secret FROM vault.decrypted_secrets
      WHERE name = 'coinbase_api_key_name' LIMIT 1) AS api_key_name,
    (SELECT decrypted_secret FROM vault.decrypted_secrets
      WHERE name = 'coinbase_api_key_private_pem' LIMIT 1) AS api_key_private_pem;
END;
$$;

-- Only service_role (edge functions) can call this — no user or anon access.
REVOKE ALL ON FUNCTION public.get_coinbase_broker_credentials() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_coinbase_broker_credentials() TO service_role;

COMMENT ON FUNCTION public.get_coinbase_broker_credentials() IS
  'Returns Coinbase Advanced Trade API credentials from Vault. '
  'Used by broker-execute and all live-mode execution paths. '
  'Secrets must be inserted manually — see migration header for instructions.';
