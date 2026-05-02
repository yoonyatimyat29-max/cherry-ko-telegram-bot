CREATE TABLE IF NOT EXISTS public.bot_broadcast_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL,
  source_chat_id bigint NOT NULL,
  source_message_id bigint NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  delivered_count integer NOT NULL DEFAULT 0,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (bot_id, source_chat_id, source_message_id)
);

ALTER TABLE public.bot_broadcast_deliveries ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'bot_broadcast_deliveries'
      AND policyname = 'Service role full access on bot_broadcast_deliveries'
  ) THEN
    CREATE POLICY "Service role full access on bot_broadcast_deliveries"
    ON public.bot_broadcast_deliveries
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bot_broadcast_deliveries_bot_updated
  ON public.bot_broadcast_deliveries (bot_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_broadcast_deliveries_source
  ON public.bot_broadcast_deliveries (source_chat_id, source_message_id);