-- ============================================================
-- TRADER OS — live data schema
-- ============================================================

-- account_state: one row per user
CREATE TABLE public.account_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  equity numeric NOT NULL DEFAULT 10000,
  cash numeric NOT NULL DEFAULT 10000,
  start_of_day_equity numeric NOT NULL DEFAULT 10000,
  balance_floor numeric NOT NULL DEFAULT 9500,
  base_currency text NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.account_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own account_state select" ON public.account_state FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own account_state insert" ON public.account_state FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own account_state update" ON public.account_state FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own account_state delete" ON public.account_state FOR DELETE USING (auth.uid() = user_id);
CREATE TRIGGER set_account_state_updated_at BEFORE UPDATE ON public.account_state
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- system_state: one row per user
CREATE TABLE public.system_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  mode text NOT NULL DEFAULT 'paper',
  bot text NOT NULL DEFAULT 'paused',
  broker_connection text NOT NULL DEFAULT 'connected',
  data_feed text NOT NULL DEFAULT 'connected',
  kill_switch_engaged boolean NOT NULL DEFAULT false,
  live_trading_enabled boolean NOT NULL DEFAULT false,
  uptime_hours numeric NOT NULL DEFAULT 0,
  last_heartbeat timestamptz NOT NULL DEFAULT now(),
  latency_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.system_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own system_state select" ON public.system_state FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own system_state insert" ON public.system_state FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own system_state update" ON public.system_state FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own system_state delete" ON public.system_state FOR DELETE USING (auth.uid() = user_id);
CREATE TRIGGER set_system_state_updated_at BEFORE UPDATE ON public.system_state
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- strategies
CREATE TABLE public.strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  version text NOT NULL,
  status text NOT NULL DEFAULT 'candidate',
  description text NOT NULL DEFAULT '',
  params jsonb NOT NULL DEFAULT '[]'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.strategies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own strategies select" ON public.strategies FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own strategies insert" ON public.strategies FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own strategies update" ON public.strategies FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own strategies delete" ON public.strategies FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX idx_strategies_user ON public.strategies(user_id);
CREATE TRIGGER set_strategies_updated_at BEFORE UPDATE ON public.strategies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- trades
CREATE TABLE public.trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  size numeric NOT NULL,
  entry_price numeric NOT NULL,
  exit_price numeric,
  stop_loss numeric,
  take_profit numeric,
  current_price numeric,
  pnl numeric,
  pnl_pct numeric,
  unrealized_pnl numeric,
  unrealized_pnl_pct numeric,
  status text NOT NULL DEFAULT 'open',
  outcome text,
  reason_tags text[] NOT NULL DEFAULT '{}',
  strategy_version text NOT NULL DEFAULT '',
  notes text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own trades select" ON public.trades FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own trades insert" ON public.trades FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own trades update" ON public.trades FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own trades delete" ON public.trades FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX idx_trades_user_status ON public.trades(user_id, status);
CREATE INDEX idx_trades_user_opened ON public.trades(user_id, opened_at DESC);
CREATE TRIGGER set_trades_updated_at BEFORE UPDATE ON public.trades
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- journal_entries
CREATE TABLE public.journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'research',
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  raw jsonb,
  llm_explanation text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own journal select" ON public.journal_entries FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own journal insert" ON public.journal_entries FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own journal update" ON public.journal_entries FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own journal delete" ON public.journal_entries FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX idx_journal_user_created ON public.journal_entries(user_id, created_at DESC);
CREATE TRIGGER set_journal_updated_at BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- guardrails
CREATE TABLE public.guardrails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  current_value text NOT NULL DEFAULT '',
  limit_value text NOT NULL DEFAULT '',
  level text NOT NULL DEFAULT 'safe',
  utilization numeric NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.guardrails ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own guardrails select" ON public.guardrails FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own guardrails insert" ON public.guardrails FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own guardrails update" ON public.guardrails FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own guardrails delete" ON public.guardrails FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX idx_guardrails_user ON public.guardrails(user_id, sort_order);
CREATE TRIGGER set_guardrails_updated_at BEFORE UPDATE ON public.guardrails
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- experiments
CREATE TABLE public.experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  parameter text NOT NULL DEFAULT '',
  before_value text NOT NULL DEFAULT '',
  after_value text NOT NULL DEFAULT '',
  delta text NOT NULL DEFAULT '',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.experiments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own experiments select" ON public.experiments FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own experiments insert" ON public.experiments FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own experiments update" ON public.experiments FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own experiments delete" ON public.experiments FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX idx_experiments_user ON public.experiments(user_id, created_at DESC);
CREATE TRIGGER set_experiments_updated_at BEFORE UPDATE ON public.experiments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- alerts
CREATE TABLE public.alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own alerts select" ON public.alerts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own alerts insert" ON public.alerts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own alerts update" ON public.alerts FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own alerts delete" ON public.alerts FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX idx_alerts_user_created ON public.alerts(user_id, created_at DESC);

-- ============================================================
-- Realtime
-- ============================================================
ALTER TABLE public.trades REPLICA IDENTITY FULL;
ALTER TABLE public.alerts REPLICA IDENTITY FULL;
ALTER TABLE public.account_state REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.trades;
ALTER PUBLICATION supabase_realtime ADD TABLE public.alerts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.account_state;

-- ============================================================
-- Updated handle_new_user: also seed starter rows
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  );

  INSERT INTO public.account_state (user_id) VALUES (NEW.id);
  INSERT INTO public.system_state (user_id) VALUES (NEW.id);

  INSERT INTO public.strategies (user_id, name, version, status, description, params, metrics)
  VALUES (
    NEW.id,
    'trend-rev',
    'v1.3',
    'approved',
    'Trend-following with mean-reversion exits. Conservative sizing.',
    '[
      {"key":"rsi_period","value":14},
      {"key":"ema_fast","value":9},
      {"key":"ema_slow","value":21},
      {"key":"max_order_pct","value":0.25,"unit":"%"},
      {"key":"stop_atr_mult","value":1.5}
    ]'::jsonb,
    '{"expectancy":0.42,"winRate":0.58,"maxDrawdown":-3.1,"sharpe":1.42,"trades":127}'::jsonb
  );

  INSERT INTO public.guardrails (user_id, label, description, current_value, limit_value, level, utilization, sort_order) VALUES
    (NEW.id, 'Max order size', 'Largest single order vs equity', '0.18%', '0.25%', 'safe', 0.72, 1),
    (NEW.id, 'Daily loss cap', 'Total losses today vs cap', '0.27%', '1.50%', 'safe', 0.18, 2),
    (NEW.id, 'Daily trade cap', 'Trades placed today', '3', '6', 'safe', 0.5, 3),
    (NEW.id, 'Balance floor', 'Equity vs hard floor', '$10,000', '$9,500', 'safe', 0.05, 4),
    (NEW.id, 'Spread filter', 'Current spread vs max', '2.1 bps', '5.0 bps', 'safe', 0.42, 5),
    (NEW.id, 'Stale data', 'Seconds since last tick', '0.4s', '5.0s', 'safe', 0.08, 6),
    (NEW.id, 'Drawdown', 'Peak-to-trough drawdown', '-1.2%', '-5.0%', 'safe', 0.24, 7),
    (NEW.id, 'Latency', 'Round-trip to broker', '42ms', '250ms', 'safe', 0.17, 8);

  RETURN NEW;
END;
$function$;

-- Ensure trigger exists on auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();