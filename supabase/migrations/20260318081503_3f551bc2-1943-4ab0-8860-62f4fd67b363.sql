
-- Table to store Bot 2 instances created by Bot 1
CREATE TABLE public.bots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  api_key TEXT NOT NULL,
  bot_username TEXT,
  bot_name TEXT,
  owner_chat_id BIGINT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.bots ENABLE ROW LEVEL SECURITY;

-- Only service_role can access bots table
CREATE POLICY "Service role full access on bots"
  ON public.bots FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Table to store trigger-response pairs (the "brain")
CREATE TABLE public.trigger_responses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bot_id UUID NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
  trigger_text TEXT NOT NULL,
  response_text TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.trigger_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on trigger_responses"
  ON public.trigger_responses FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Index for fast trigger lookup
CREATE INDEX idx_trigger_responses_trigger ON public.trigger_responses (bot_id, trigger_text);

-- Table to track round-robin pointer per trigger per bot
CREATE TABLE public.trigger_pointers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bot_id UUID NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
  trigger_text TEXT NOT NULL,
  pointer INT NOT NULL DEFAULT 0,
  UNIQUE(bot_id, trigger_text)
);

ALTER TABLE public.trigger_pointers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on trigger_pointers"
  ON public.trigger_pointers FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Bot 1 polling state
CREATE TABLE public.bot1_state (
  id INT PRIMARY KEY CHECK (id = 1),
  update_offset BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.bot1_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on bot1_state"
  ON public.bot1_state FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

INSERT INTO public.bot1_state (id, update_offset) VALUES (1, 0);

-- Bot 2 polling state per bot instance
CREATE TABLE public.bot2_states (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bot_id UUID NOT NULL UNIQUE REFERENCES public.bots(id) ON DELETE CASCADE,
  update_offset BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.bot2_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on bot2_states"
  ON public.bot2_states FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- User conversation state tracking for Bot 1 (waiting for API key)
CREATE TABLE public.bot1_conversations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  chat_id BIGINT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'idle',
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.bot1_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on bot1_conversations"
  ON public.bot1_conversations FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
