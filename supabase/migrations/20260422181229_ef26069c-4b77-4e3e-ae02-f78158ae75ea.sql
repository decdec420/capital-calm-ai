-- Lock down realtime.messages so authenticated users can only subscribe
-- to channel topics that include their own user UUID. All client hooks
-- already use the convention `<table>:<user.id>:<nonce>`, so this is a
-- pure security tightening with zero behavior change for owners.

ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own user topic select" ON realtime.messages;
DROP POLICY IF EXISTS "own user topic insert" ON realtime.messages;

CREATE POLICY "own user topic select"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() IS NOT NULL
    AND realtime.topic() LIKE '%' || auth.uid()::text || '%'
  );

CREATE POLICY "own user topic insert"
  ON realtime.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND realtime.topic() LIKE '%' || auth.uid()::text || '%'
  );