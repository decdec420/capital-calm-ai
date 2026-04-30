-- Ensure system_events is queryable via PostgREST by authenticated users.
-- RLS remains the primary access control; grants only enable table access.

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT ON TABLE public.system_events TO authenticated;
GRANT SELECT, INSERT ON TABLE public.system_events TO service_role;
