-- Phase 2: allow multiple approved strategies per user (regime router).
DROP INDEX IF EXISTS public.strategies_one_approved_per_user;

-- But still prevent literal duplicates (same name + version both approved).
CREATE UNIQUE INDEX IF NOT EXISTS strategies_unique_name_version_per_user
  ON public.strategies (user_id, name, version)
  WHERE status = 'approved';