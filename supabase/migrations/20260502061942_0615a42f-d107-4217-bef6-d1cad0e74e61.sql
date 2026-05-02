DROP POLICY IF EXISTS "Service role full access on bot_broadcast_deliveries" ON public.bot_broadcast_deliveries;

CREATE POLICY "Backend workers can manage bot_broadcast_deliveries"
ON public.bot_broadcast_deliveries
FOR ALL
TO service_role
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');