-- ============================================================
-- Diamond-Tier Doctrine — Phase 1 foundations
-- ============================================================

-- ── doctrine_symbol_overrides ──────────────────────────────
CREATE TABLE public.doctrine_symbol_overrides (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL,
  symbol                text NOT NULL,
  enabled               boolean NOT NULL DEFAULT true,
  max_order_pct         numeric,
  risk_per_trade_pct    numeric,
  daily_loss_pct        numeric,
  max_trades_per_day    integer,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol)
);

ALTER TABLE public.doctrine_symbol_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own symbol_overrides select" ON public.doctrine_symbol_overrides
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own symbol_overrides insert" ON public.doctrine_symbol_overrides
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own symbol_overrides update" ON public.doctrine_symbol_overrides
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own symbol_overrides delete" ON public.doctrine_symbol_overrides
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER trg_symbol_overrides_updated
  BEFORE UPDATE ON public.doctrine_symbol_overrides
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Tighten-only validator: an override may only ever be MORE conservative
-- than the global doctrine value (engine still re-validates at tick time,
-- this trigger catches obvious misconfigurations early).
CREATE OR REPLACE FUNCTION public.validate_doctrine_symbol_override()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.max_order_pct IS NOT NULL
     AND (NEW.max_order_pct < 0 OR NEW.max_order_pct > 0.5) THEN
    RAISE EXCEPTION 'max_order_pct override must be in [0, 0.5]';
  END IF;
  IF NEW.risk_per_trade_pct IS NOT NULL
     AND (NEW.risk_per_trade_pct < 0 OR NEW.risk_per_trade_pct > 0.1) THEN
    RAISE EXCEPTION 'risk_per_trade_pct override must be in [0, 0.1]';
  END IF;
  IF NEW.daily_loss_pct IS NOT NULL
     AND (NEW.daily_loss_pct < 0 OR NEW.daily_loss_pct > 0.5) THEN
    RAISE EXCEPTION 'daily_loss_pct override must be in [0, 0.5]';
  END IF;
  IF NEW.max_trades_per_day IS NOT NULL
     AND (NEW.max_trades_per_day < 1 OR NEW.max_trades_per_day > 100) THEN
    RAISE EXCEPTION 'max_trades_per_day override must be in [1, 100]';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_symbol_overrides_validate
  BEFORE INSERT OR UPDATE ON public.doctrine_symbol_overrides
  FOR EACH ROW EXECUTE FUNCTION public.validate_doctrine_symbol_override();


-- ── doctrine_windows ───────────────────────────────────────
-- A window is a (days, time-range, mode) tuple. Engine selects the
-- HIGHEST-tightening mode active right now. days: 0=Sun..6=Sat per UTC.
CREATE TABLE public.doctrine_windows (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  label        text NOT NULL,
  days         integer[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6],
  start_utc    text NOT NULL, -- "HH:MM"
  end_utc      text NOT NULL, -- "HH:MM"
  mode         text NOT NULL CHECK (mode IN ('calm','choppy','storm','lockout')),
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.doctrine_windows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own doctrine_windows select" ON public.doctrine_windows
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own doctrine_windows insert" ON public.doctrine_windows
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own doctrine_windows update" ON public.doctrine_windows
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own doctrine_windows delete" ON public.doctrine_windows
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER trg_doctrine_windows_updated
  BEFORE UPDATE ON public.doctrine_windows
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ── doctrine_versions ─────────────────────────────────────
-- Every applied change snapshots the resolved settings + overrides here.
CREATE TABLE public.doctrine_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  version_no    bigint NOT NULL,
  label         text,
  source        text NOT NULL DEFAULT 'system',  -- user | wags | system | cooldown-activation
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  overrides     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, version_no)
);

ALTER TABLE public.doctrine_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own doctrine_versions select" ON public.doctrine_versions
  FOR SELECT USING (auth.uid() = user_id);
-- writes are server-side only (service role) — no INSERT/UPDATE/DELETE policy.

-- Auto-snapshot on every doctrine_settings change. Captures the post-
-- change row + current overrides, increments version_no per user.
CREATE OR REPLACE FUNCTION public.snapshot_doctrine_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next       bigint;
  v_overrides  jsonb;
  v_source     text;
BEGIN
  SELECT COALESCE(MAX(version_no), 0) + 1
    INTO v_next
    FROM public.doctrine_versions
   WHERE user_id = NEW.user_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(o.*) ORDER BY o.symbol), '[]'::jsonb)
    INTO v_overrides
    FROM public.doctrine_symbol_overrides o
   WHERE o.user_id = NEW.user_id;

  v_source := COALESCE(NEW.updated_via, 'system');

  INSERT INTO public.doctrine_versions
    (user_id, version_no, source, settings, overrides)
  VALUES
    (NEW.user_id, v_next, v_source, to_jsonb(NEW.*), v_overrides);

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_doctrine_versions_snapshot
  AFTER INSERT OR UPDATE ON public.doctrine_settings
  FOR EACH ROW EXECUTE FUNCTION public.snapshot_doctrine_version();


-- ── system_state.doctrine_overlay_today ──────────────────
-- Ephemeral overlay computed each tick; cleared at UTC rollover by
-- the existing rollover-day cron. JSON shape:
--   { "mode": "choppy" | "storm" | "lockout" | null,
--     "drawdown_step": 0..3,
--     "size_mult": 0..1, "trades_mult": 0..1,
--     "reasons": ["dd:-2.1%", "window:weekend-lowliq"],
--     "computed_at": "..." }
ALTER TABLE public.system_state
  ADD COLUMN IF NOT EXISTS doctrine_overlay_today jsonb NOT NULL DEFAULT '{}'::jsonb;
