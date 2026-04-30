-- ============================================================
-- Broker Health + Vault helpers
-- ============================================================

-- Per-user broker connection status row
CREATE TABLE IF NOT EXISTS public.broker_health (
  user_id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'not_connected'
                     CHECK (status IN ('not_connected','healthy','auth_failed','unknown')),
  key_name         TEXT,
  last_success_at  TIMESTAMPTZ,
  last_failure_at  TIMESTAMPTZ,
  last_error       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.broker_health ENABLE ROW LEVEL SECURITY;

-- Users can read their own row only. Writes happen through SECURITY DEFINER
-- helpers called from edge functions running as service_role.
DROP POLICY IF EXISTS "Users view own broker health" ON public.broker_health;
CREATE POLICY "Users view own broker health"
  ON public.broker_health
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Realtime so the global banner reacts within ~1s of an auth probe failure
ALTER PUBLICATION supabase_realtime ADD TABLE public.broker_health;

-- ── Vault upsert helper (service_role only) ─────────────────
-- Wraps vault.create_secret / vault.update_secret so the edge function
-- never has to know whether the secret already exists.
CREATE OR REPLACE FUNCTION public.upsert_broker_secret(p_name text, p_value text, p_description text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = p_name LIMIT 1;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(p_value, p_name, COALESCE(p_description, p_name));
  ELSE
    PERFORM vault.update_secret(v_id, p_value, p_name, COALESCE(p_description, p_name));
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_broker_secret(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_broker_secret(text, text, text) TO service_role;

-- Delete both broker secrets in one shot
CREATE OR REPLACE FUNCTION public.delete_broker_secrets()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
BEGIN
  PERFORM vault.delete_secret(id) FROM vault.secrets
   WHERE name IN ('coinbase_api_key_name','coinbase_api_key_private_pem');
END;
$$;

REVOKE ALL ON FUNCTION public.delete_broker_secrets() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_broker_secrets() TO service_role;

-- Update broker_health row from edge functions
CREATE OR REPLACE FUNCTION public.update_broker_health(
  p_user_id uuid,
  p_status text,
  p_key_name text DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('not_connected','healthy','auth_failed','unknown') THEN
    RAISE EXCEPTION 'invalid status: %', p_status;
  END IF;

  INSERT INTO public.broker_health (
    user_id, status, key_name,
    last_success_at, last_failure_at, last_error, updated_at
  ) VALUES (
    p_user_id, p_status, p_key_name,
    CASE WHEN p_status = 'healthy' THEN now() ELSE NULL END,
    CASE WHEN p_status = 'auth_failed' THEN now() ELSE NULL END,
    p_error, now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    status          = EXCLUDED.status,
    key_name        = COALESCE(EXCLUDED.key_name, broker_health.key_name),
    last_success_at = COALESCE(EXCLUDED.last_success_at, broker_health.last_success_at),
    last_failure_at = COALESCE(EXCLUDED.last_failure_at, broker_health.last_failure_at),
    last_error      = CASE WHEN EXCLUDED.status = 'healthy' THEN NULL ELSE EXCLUDED.last_error END,
    updated_at      = now();
END;
$$;

REVOKE ALL ON FUNCTION public.update_broker_health(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_broker_health(uuid, text, text, text) TO service_role;

-- updated_at trigger
DROP TRIGGER IF EXISTS broker_health_updated_at ON public.broker_health;
CREATE TRIGGER broker_health_updated_at
  BEFORE UPDATE ON public.broker_health
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();