-- ============================================================
-- Phase 5: Signal TTL enforcement + dual-cron fix
-- ------------------------------------------------------------
-- 1. Remove the duplicate signal-engine cron job that fires every
--    2 minutes. Only signal-engine-tick-aggressive (1 min) should
--    run — having both causes concurrent calls on even minutes,
--    which can double-propose signals and thrash the snapshot table.
--
-- 2. trade_signals.expires_at already exists but is never SET on
--    insert, so signals accumulate indefinitely through pause windows
--    (NULL < anything = false in SQL → expirePendingSignals never
--    fires). This migration:
--      a. Sets a DEFAULT of NOW() + 30 minutes on the column so every
--         new signal auto-gets a TTL without any app code change.
--      b. Back-fills the 30-min TTL on any existing pending signals
--         that slipped through without an expiry.
-- ============================================================

-- ── 1. Remove duplicate cron job ─────────────────────────────
-- signal-engine-tick-active fires every 2 min and races with the
-- 1-min job on even minutes. Remove it.
SELECT cron.unschedule('signal-engine-tick-active');

-- ── 2. Enforce signal TTL via column DEFAULT ──────────────────
-- Set a 30-minute default so every INSERT automatically gets an
-- expiry without requiring the app to pass one explicitly.
ALTER TABLE public.trade_signals
  ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '30 minutes');

-- Back-fill existing pending signals that have no expiry.
UPDATE public.trade_signals
SET expires_at = NOW() + INTERVAL '30 minutes'
WHERE status = 'pending'
  AND expires_at IS NULL;

-- Index to make expiry scans and Bobby's pending-signal filter fast.
CREATE INDEX IF NOT EXISTS trade_signals_expires_at_pending_idx
  ON public.trade_signals (user_id, expires_at)
  WHERE status = 'pending';
