
CREATE TABLE IF NOT EXISTS bot_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  chat_id bigint NOT NULL,
  chat_title text,
  chat_type text NOT NULL DEFAULT 'group',
  chat_username text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(bot_id, chat_id)
);

ALTER TABLE bot_chats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on bot_chats" ON bot_chats FOR ALL TO service_role USING (true) WITH CHECK (true);
