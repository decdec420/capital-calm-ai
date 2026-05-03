-- Phase 3: Statistical honesty views
-- Goal: every metric reported with a 95% confidence interval so we can
-- distinguish real edge from noise before risking real money.

-- Drop old single-point view and replace with CI-aware version.
-- (We keep the same name `strategy_performance_v` so existing callers
-- still work, and add the new CI columns alongside.)

CREATE OR REPLACE VIEW public.strategy_performance_v
WITH (security_invoker = true)
AS
WITH base AS (
  SELECT
    s.id              AS strategy_id,
    s.user_id,
    s.name            AS strategy_name,
    s.version         AS strategy_version,
    s.status,
    s.risk_weight,
    s.regime_affinity,
    s.side_capability,
    t.id              AS trade_id,
    t.status          AS trade_status,
    t.outcome,
    t.pnl,
    t.pnl_pct,
    t.closed_at
  FROM public.strategies s
  LEFT JOIN public.trades t ON t.strategy_id = s.id
)
SELECT
  strategy_id,
  user_id,
  strategy_name,
  strategy_version,
  status,
  risk_weight,
  regime_affinity,
  side_capability,
  COUNT(trade_id)                                                AS total_trades,
  COUNT(trade_id) FILTER (WHERE trade_status = 'closed')         AS closed_trades,
  COUNT(trade_id) FILTER (WHERE outcome = 'win')                 AS wins,
  COUNT(trade_id) FILTER (WHERE outcome = 'loss')                AS losses,
  COALESCE(SUM(pnl) FILTER (WHERE trade_status = 'closed'), 0)   AS total_pnl,
  COALESCE(AVG(pnl) FILTER (WHERE trade_status = 'closed'), 0)   AS avg_pnl,
  COALESCE(AVG(pnl_pct) FILTER (WHERE trade_status = 'closed'), 0) AS avg_pnl_pct,
  CASE
    WHEN COUNT(trade_id) FILTER (WHERE trade_status = 'closed') > 0
    THEN COUNT(trade_id) FILTER (WHERE outcome = 'win')::numeric
       / NULLIF(COUNT(trade_id) FILTER (WHERE trade_status = 'closed'), 0)::numeric
    ELSE NULL
  END                                                            AS win_rate,
  MAX(closed_at)                                                 AS last_closed_at
FROM base
GROUP BY strategy_id, user_id, strategy_name, strategy_version, status, risk_weight, regime_affinity, side_capability;


-- New view: same metrics + 95% CIs + evidence flag.
-- Uses analytical CI formulas (Wilson for proportions, t-based for means,
-- Lo 2002 SE for Sharpe). These give the same honesty as bootstrap
-- without the cost of resampling in SQL.
CREATE OR REPLACE VIEW public.strategy_performance_ci_v
WITH (security_invoker = true)
AS
WITH closed AS (
  SELECT
    s.id              AS strategy_id,
    s.user_id,
    s.name            AS strategy_name,
    s.version         AS strategy_version,
    s.status,
    s.risk_weight,
    t.outcome,
    t.pnl,
    t.pnl_pct
  FROM public.strategies s
  LEFT JOIN public.trades t
    ON t.strategy_id = s.id
   AND t.status      = 'closed'
),
agg AS (
  SELECT
    strategy_id,
    user_id,
    strategy_name,
    strategy_version,
    status,
    risk_weight,
    COUNT(pnl)                          AS n,
    COUNT(*) FILTER (WHERE outcome='win')  AS wins,
    COUNT(*) FILTER (WHERE outcome='loss') AS losses,
    COALESCE(SUM(pnl), 0)               AS total_pnl,
    COALESCE(AVG(pnl), 0)               AS avg_pnl,
    COALESCE(STDDEV_SAMP(pnl), 0)       AS sd_pnl,
    COALESCE(AVG(pnl_pct), 0)           AS avg_pnl_pct,
    COALESCE(STDDEV_SAMP(pnl_pct), 0)   AS sd_pnl_pct
  FROM closed
  GROUP BY strategy_id, user_id, strategy_name, strategy_version, status, risk_weight
)
SELECT
  strategy_id,
  user_id,
  strategy_name,
  strategy_version,
  status,
  risk_weight,
  n                                AS closed_trades,
  wins,
  losses,
  total_pnl,
  avg_pnl,
  avg_pnl_pct,
  CASE WHEN n > 0 THEN wins::numeric / n ELSE NULL END AS win_rate,

  -- Wilson 95% CI for win-rate. Honest for small N, doesn't blow up at p=0 or p=1.
  CASE WHEN n > 0 THEN
    ((wins::numeric/n) + 1.96*1.96/(2*n)
      - 1.96*sqrt(((wins::numeric/n)*(1-(wins::numeric/n)) + 1.96*1.96/(4*n))/n))
    / (1 + 1.96*1.96/n)
  END                              AS win_rate_lo,
  CASE WHEN n > 0 THEN
    ((wins::numeric/n) + 1.96*1.96/(2*n)
      + 1.96*sqrt(((wins::numeric/n)*(1-(wins::numeric/n)) + 1.96*1.96/(4*n))/n))
    / (1 + 1.96*1.96/n)
  END                              AS win_rate_hi,

  -- 95% CI for expectancy (avg PnL) using t-distribution approximation (z=1.96 for n>=30).
  CASE WHEN n >= 2 THEN avg_pnl - 1.96 * sd_pnl / sqrt(n) END     AS avg_pnl_lo,
  CASE WHEN n >= 2 THEN avg_pnl + 1.96 * sd_pnl / sqrt(n) END     AS avg_pnl_hi,

  -- Sharpe ratio (per-trade) and its 95% CI via Lo (2002) SE: SE(SR) ≈ sqrt((1+SR^2/2)/n).
  CASE WHEN sd_pnl > 0 THEN avg_pnl / sd_pnl END                  AS sharpe,
  CASE WHEN sd_pnl > 0 AND n >= 2
       THEN (avg_pnl/sd_pnl) - 1.96 * sqrt((1 + power(avg_pnl/sd_pnl, 2)/2.0) / n)
  END                                                             AS sharpe_lo,
  CASE WHEN sd_pnl > 0 AND n >= 2
       THEN (avg_pnl/sd_pnl) + 1.96 * sqrt((1 + power(avg_pnl/sd_pnl, 2)/2.0) / n)
  END                                                             AS sharpe_hi,

  -- Evidence gate. Below 30 closed trades, every verdict is suspect.
  CASE
    WHEN n = 0           THEN 'no_data'
    WHEN n < 30          THEN 'insufficient_evidence'
    WHEN n < 100         THEN 'developing'
    ELSE 'sufficient'
  END                              AS evidence_status,

  -- Honest verdict: positive expectancy ONLY if the lower bound of avg_pnl is > 0.
  -- Anything else is "not yet proven" regardless of the point estimate.
  CASE
    WHEN n < 30                                          THEN 'unproven'
    WHEN avg_pnl - 1.96 * sd_pnl / sqrt(n) > 0           THEN 'positive_edge'
    WHEN avg_pnl + 1.96 * sd_pnl / sqrt(n) < 0           THEN 'negative_edge'
    ELSE 'inconclusive'
  END                              AS edge_verdict
FROM agg;


-- Per (strategy × regime) breakdown so we can catch
-- "looks great overall, only works in trending_up" traps.
CREATE OR REPLACE VIEW public.strategy_regime_perf_v
WITH (security_invoker = true)
AS
WITH closed_with_regime AS (
  SELECT
    s.id        AS strategy_id,
    s.user_id,
    s.name      AS strategy_name,
    s.version   AS strategy_version,
    -- Pick the regime tag from reason_tags, if any.
    COALESCE(
      (SELECT tag FROM unnest(t.reason_tags) AS tag
        WHERE tag = ANY(ARRAY['trending_up','trending_down','breakout','range','chop'])
        LIMIT 1),
      'unknown'
    )           AS regime,
    t.outcome,
    t.pnl
  FROM public.strategies s
  JOIN public.trades t
    ON t.strategy_id = s.id
   AND t.status      = 'closed'
)
SELECT
  strategy_id,
  user_id,
  strategy_name,
  strategy_version,
  regime,
  COUNT(*)                                       AS closed_trades,
  COUNT(*) FILTER (WHERE outcome = 'win')        AS wins,
  COUNT(*) FILTER (WHERE outcome = 'loss')       AS losses,
  COALESCE(SUM(pnl), 0)                          AS total_pnl,
  COALESCE(AVG(pnl), 0)                          AS avg_pnl,
  COALESCE(STDDEV_SAMP(pnl), 0)                  AS sd_pnl,
  CASE WHEN COUNT(*) > 0
       THEN COUNT(*) FILTER (WHERE outcome='win')::numeric / COUNT(*)
  END                                            AS win_rate,
  -- Wilson CI on win-rate per regime
  CASE WHEN COUNT(*) > 0 THEN
    ((COUNT(*) FILTER (WHERE outcome='win')::numeric/COUNT(*)) + 1.96*1.96/(2*COUNT(*))
      - 1.96*sqrt(((COUNT(*) FILTER (WHERE outcome='win')::numeric/COUNT(*))*
                   (1-(COUNT(*) FILTER (WHERE outcome='win')::numeric/COUNT(*))) + 1.96*1.96/(4*COUNT(*)))/COUNT(*)))
    / (1 + 1.96*1.96/COUNT(*))
  END                                            AS win_rate_lo,
  CASE WHEN COUNT(*) > 0 THEN
    ((COUNT(*) FILTER (WHERE outcome='win')::numeric/COUNT(*)) + 1.96*1.96/(2*COUNT(*))
      + 1.96*sqrt(((COUNT(*) FILTER (WHERE outcome='win')::numeric/COUNT(*))*
                   (1-(COUNT(*) FILTER (WHERE outcome='win')::numeric/COUNT(*))) + 1.96*1.96/(4*COUNT(*)))/COUNT(*)))
    / (1 + 1.96*1.96/COUNT(*))
  END                                            AS win_rate_hi,
  CASE WHEN COUNT(*) >= 2 THEN AVG(pnl) - 1.96 * STDDEV_SAMP(pnl) / sqrt(COUNT(*)) END AS avg_pnl_lo,
  CASE WHEN COUNT(*) >= 2 THEN AVG(pnl) + 1.96 * STDDEV_SAMP(pnl) / sqrt(COUNT(*)) END AS avg_pnl_hi,
  CASE
    WHEN COUNT(*) = 0   THEN 'no_data'
    WHEN COUNT(*) < 15  THEN 'insufficient_evidence'
    WHEN COUNT(*) < 50  THEN 'developing'
    ELSE 'sufficient'
  END                                            AS evidence_status
FROM closed_with_regime
GROUP BY strategy_id, user_id, strategy_name, strategy_version, regime;