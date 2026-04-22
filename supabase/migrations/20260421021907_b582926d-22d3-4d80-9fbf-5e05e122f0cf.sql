-- Conversations: one row per thread
CREATE TABLE public.chat_conversations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  title TEXT NOT NULL DEFAULT 'New conversation',
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own conversations select" ON public.chat_conversations
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own conversations insert" ON public.chat_conversations
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own conversations update" ON public.chat_conversations
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own conversations delete" ON public.chat_conversations
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER update_chat_conversations_updated_at
  BEFORE UPDATE ON public.chat_conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_chat_conversations_user_recent
  ON public.chat_conversations (user_id, last_message_at DESC);

-- Messages: one row per turn
CREATE TABLE public.chat_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own messages select" ON public.chat_messages
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own messages insert" ON public.chat_messages
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own messages update" ON public.chat_messages
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own messages delete" ON public.chat_messages
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_chat_messages_conversation
  ON public.chat_messages (conversation_id, created_at ASC);

-- Auto-bump the conversation's last_message_at and auto-title from the first user message
CREATE OR REPLACE FUNCTION public.touch_conversation_on_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_title TEXT;
  v_new_title TEXT;
BEGIN
  -- Only auto-title when the conversation still has the default title and this is a user message
  SELECT title INTO v_existing_title FROM public.chat_conversations WHERE id = NEW.conversation_id;
  IF NEW.role = 'user' AND v_existing_title = 'New conversation' THEN
    v_new_title := trim(substring(NEW.content from 1 for 60));
    IF length(NEW.content) > 60 THEN
      v_new_title := v_new_title || '…';
    END IF;
    UPDATE public.chat_conversations
       SET title = COALESCE(NULLIF(v_new_title, ''), 'New conversation'),
           last_message_at = now()
     WHERE id = NEW.conversation_id;
  ELSE
    UPDATE public.chat_conversations
       SET last_message_at = now()
     WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER chat_messages_touch_conversation
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.touch_conversation_on_message();