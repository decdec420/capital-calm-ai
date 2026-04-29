ALTER TABLE public.experiments REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.experiments;