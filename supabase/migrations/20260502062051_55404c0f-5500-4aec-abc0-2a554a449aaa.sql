CREATE TABLE IF NOT EXISTS public.bot_broadcast_recipient_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_chat_id bigint NOT NULL,
  source_message_id bigint NOT NULL,
  target_chat_id bigint NOT NULL,
  bot_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  error_text text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (source_chat_id, source_message_id, target_chat_id)
);

ALTER TABLE public.bot_broadcast_recipient_deliveries ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'bot_broadcast_recipient_deliveries'
      AND policyname = 'Backend workers can manage bot_broadcast_recipient_deliveries'
  ) THEN
    CREATE POLICY "Backend workers can manage bot_broadcast_recipient_deliveries"
    ON public.bot_broadcast_recipient_deliveries
    FOR ALL
    TO service_role
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bot_broadcast_recipient_source
  ON public.bot_broadcast_recipient_deliveries (source_chat_id, source_message_id);

CREATE INDEX IF NOT EXISTS idx_bot_broadcast_recipient_bot_updated
  ON public.bot_broadcast_recipient_deliveries (bot_id, updated_at DESC);