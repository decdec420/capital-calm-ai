-- Drop the overly-permissive view policy if it still exists
DROP POLICY IF EXISTS "Authenticated users can view profiles" ON public.profiles;

-- Ensure the strict owner-only view policy is in place
DROP POLICY IF EXISTS "Users can view their own profile" ON public.profiles;
CREATE POLICY "Users can view their own profile"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);