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

REVOKE ALL ON FUNCTION public.get_coinbase_broker_credentials() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_coinbase_broker_credentials() TO service_role;

NOTIFY pgrst, 'reload schema';