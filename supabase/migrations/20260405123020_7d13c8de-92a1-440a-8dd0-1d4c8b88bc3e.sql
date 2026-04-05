
CREATE TABLE public.bot_links (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bot_id UUID NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
  link_url TEXT NOT NULL,
  link_title TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_bot_links_bot_id ON public.bot_links (bot_id);

ALTER TABLE public.bot_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read bot_links"
ON public.bot_links FOR SELECT
USING (true);

CREATE POLICY "Service role can manage bot_links"
ON public.bot_links FOR ALL
USING (true)
WITH CHECK (true);
