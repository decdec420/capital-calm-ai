
-- 1. Generate (if missing) and store the cron token in the vault.
DO $$
DECLARE
  v_existing text;
  v_new      text;
BEGIN
  SELECT decrypted_secret INTO v_existing
  FROM vault.decrypted_secrets
  WHERE name = 'evaluate_candidate_cron_token'
  LIMIT 1;

  IF v_existing IS NULL THEN
    v_new := encode(extensions.gen_random_bytes(32), 'hex');
    PERFORM vault.create_secret(v_new, 'evaluate_candidate_cron_token', 'Cron auth token for evaluate-candidate edge function');
  END IF;
END $$;

-- 2. RPC for the function to retrieve & verify the token.
CREATE OR REPLACE FUNCTION public.get_evaluate_candidate_cron_token()
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
  WHERE name = 'evaluate_candidate_cron_token'
  LIMIT 1;
  RETURN v_token;
END;
$$;
REVOKE ALL ON FUNCTION public.get_evaluate_candidate_cron_token() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_evaluate_candidate_cron_token() TO service_role;

-- 3. Schedule the cron — every 30 minutes. Unschedule any prior version first.
DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'evaluate-candidate-30m';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'evaluate-candidate-30m',
  '*/30 * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://klgotmhyxxtppzpbjkfu.supabase.co/functions/v1/evaluate-candidate',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || COALESCE(public.get_evaluate_candidate_cron_token(), '')
    ),
    body    := jsonb_build_object('source', 'pg_cron')
  );
  $cron$
);
