-- ============================================================
-- Kill-switch auto-resume trigger
-- ------------------------------------------------------------
-- Problem: kill_switch_engaged and bot status are independent
-- toggles. When the operator arms the kill switch, the bot is
-- paused. But when they disarm it, the bot stays paused —
-- requiring a second manual action to resume trading.
--
-- Fix: when kill_switch_engaged transitions TRUE → FALSE,
-- automatically set bot = 'running' so the desk comes back
-- online in one action, not two.
--
-- Safety: the trigger only fires on the true→false transition.
-- If the bot was paused for an independent reason (manual pause
-- by operator or Bobby) and the kill switch was never armed,
-- this trigger does not interfere.
-- ============================================================

CREATE OR REPLACE FUNCTION public.auto_resume_on_kill_switch_disarm()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Only act when kill_switch_engaged goes from TRUE → FALSE
  IF OLD.kill_switch_engaged = true AND NEW.kill_switch_engaged = false THEN
    -- Resume the bot and log the auto-resume as a system event.
    NEW.bot := 'running';

    INSERT INTO public.system_events (user_id, event_type, actor, payload)
    VALUES (
      NEW.user_id,
      'bot_auto_resumed',
      'system',
      jsonb_build_object(
        'reason', 'Kill switch disarmed — desk automatically resumed.',
        'previous_bot_status', OLD.bot,
        'triggered_by', 'auto_resume_on_kill_switch_disarm'
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kill_switch_auto_resume ON public.system_state;

CREATE TRIGGER trg_kill_switch_auto_resume
  BEFORE UPDATE OF kill_switch_engaged ON public.system_state
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_resume_on_kill_switch_disarm();
