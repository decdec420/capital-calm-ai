
ALTER TABLE public.strategies
  ADD COLUMN IF NOT EXISTS risk_weight numeric NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS regime_affinity text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS side_capability text[] NOT NULL DEFAULT ARRAY['long']::text[];

-- Sanity bounds via validation trigger (avoid CHECK constraints per project rules).
CREATE OR REPLACE FUNCTION public.validate_strategy_risk_weight()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.risk_weight IS NULL OR NEW.risk_weight < 0 OR NEW.risk_weight > 3 THEN
    RAISE EXCEPTION 'strategies.risk_weight must be in [0, 3] (got %)', NEW.risk_weight;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_strategy_risk_weight ON public.strategies;
CREATE TRIGGER trg_validate_strategy_risk_weight
BEFORE INSERT OR UPDATE OF risk_weight ON public.strategies
FOR EACH ROW EXECUTE FUNCTION public.validate_strategy_risk_weight();

-- Per-strategy rollup view. RLS: views inherit from underlying tables (trades + strategies),
-- which both already filter by auth.uid() = user_id, so each user only sees their own rows.
CREATE OR REPLACE VIEW public.strategy_performance_v
WITH (security_invoker = true)
AS
SELECT
  s.id                                           AS strategy_id,
  s.user_id                                      AS user_id,
  s.name                                         AS strategy_name,
  s.version                                      AS strategy_version,
  s.status                                       AS status,
  s.risk_weight                                  AS risk_weight,
  s.regime_affinity                              AS regime_affinity,
  s.side_capability                              AS side_capability,
  COUNT(t.id)                                    AS total_trades,
  COUNT(t.id) FILTER (WHERE t.status = 'closed') AS closed_trades,
  COUNT(t.id) FILTER (WHERE t.outcome = 'win')   AS wins,
  COUNT(t.id) FILTER (WHERE t.outcome = 'loss')  AS losses,
  COALESCE(SUM(t.pnl) FILTER (WHERE t.status = 'closed'), 0)::numeric AS total_pnl,
  COALESCE(AVG(t.pnl) FILTER (WHERE t.status = 'closed'), 0)::numeric AS avg_pnl,
  COALESCE(AVG(t.pnl_pct) FILTER (WHERE t.status = 'closed'), 0)::numeric AS avg_pnl_pct,
  CASE
    WHEN COUNT(t.id) FILTER (WHERE t.status = 'closed') > 0
    THEN (COUNT(t.id) FILTER (WHERE t.outcome = 'win')::numeric
          / NULLIF(COUNT(t.id) FILTER (WHERE t.status = 'closed'), 0))
    ELSE NULL
  END AS win_rate,
  MAX(t.closed_at)                               AS last_closed_at
FROM public.strategies s
LEFT JOIN public.trades t
  ON t.strategy_id = s.id
GROUP BY s.id;
