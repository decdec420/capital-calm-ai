-- Raise daily_auto_execute_cap_usd default from $2 to $50.
-- Existing rows where the column is NULL or still at the original $2
-- sentinel default are bumped to $50 so Bobby has room to actually trade.
-- Users who have intentionally set a custom value are not affected.

ALTER TABLE public.account_state
  ALTER COLUMN daily_auto_execute_cap_usd SET DEFAULT 50;

-- Bump rows sitting at the old default ($2) or NULL to $50.
-- $2.00 is the sentinel default; any row at exactly that value
-- was never intentionally set by the user.
UPDATE public.account_state
SET daily_auto_execute_cap_usd = 50
WHERE daily_auto_execute_cap_usd IS NULL
   OR daily_auto_execute_cap_usd = 2;
