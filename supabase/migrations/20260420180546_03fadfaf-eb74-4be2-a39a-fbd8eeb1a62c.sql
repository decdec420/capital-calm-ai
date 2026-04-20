CREATE OR REPLACE FUNCTION public.get_signal_engine_cron_token()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_token text;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets
  WHERE name = 'signal_engine_cron_token'
  LIMIT 1;
  RETURN v_token;
END;
$$;

REVOKE ALL ON FUNCTION public.get_signal_engine_cron_token() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_signal_engine_cron_token() TO service_role;