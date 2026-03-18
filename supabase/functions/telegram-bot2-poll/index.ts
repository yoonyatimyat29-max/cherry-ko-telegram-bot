import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MAX_RUNTIME_MS = 55_000;
const MIN_REMAINING_MS = 5_000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Get all active bots
  const { data: bots, error: botsErr } = await supabase
    .from('bots')
    .select('id, api_key, bot_username')
    .eq('is_active', true);

  if (botsErr || !bots?.length) {
    return new Response(JSON.stringify({ ok: true, message: 'No active bots', error: botsErr?.message }), { headers: corsHeaders });
  }

  let totalProcessed = 0;

  // Get polling states for all bots
  const { data: states } = await supabase
    .from('bot2_states')
    .select('bot_id, update_offset');

  const stateMap = new Map((states || []).map(s => [s.bot_id, s.update_offset]));

  // Process each bot - use short polling (no long poll since we have multiple bots)
  while (true) {
    const elapsed = Date.now() - startTime;
    const remainingMs = MAX_RUNTIME_MS - elapsed;
    if (remainingMs < MIN_REMAINING_MS) break;

    let anyUpdates = false;

    for (const bot of bots) {
      const offset = stateMap.get(bot.id) || 0;

      try {
        // Call Telegram API directly with bot's own token
        const response = await fetch(`https://api.telegram.org/bot${bot.api_key}/getUpdates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset,
            timeout: 1, // Short poll since we iterate multiple bots
            allowed_updates: ['message'],
          }),
        });

        const data = await response.json();
        if (!data.ok) {
          console.error(`Bot ${bot.bot_username} API error:`, data);
          continue;
        }

        const updates = data.result ?? [];
        if (updates.length === 0) continue;

        anyUpdates = true;

        for (const update of updates) {
          try {
            const msg = update.message;
            if (!msg || !msg.text) continue;

            // Skip bot messages to prevent echo loops
            if (msg.from?.is_bot) continue;

            const chatId = msg.chat.id;
            const text = msg.text;

            // Handle /start command
            if (text === '/start') {
              if (msg.chat.type === 'private') {
                await fetch(`https://api.telegram.org/bot${bot.api_key}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: chatId,
                    text: '🤖 ကျွန်တော့်ကို Group ထဲထည့်ပြီး စကားပြောသင်ပေးပါ။\n\nGroup ထဲမှာ User တွေ Reply နဲ့ စကားပြောတာကို သင်ယူမှတ်သားပြီး ပြန်ပြောပေးပါမယ်။',
                    reply_markup: {
                      inline_keyboard: [[
                        { text: '➕ Group ထဲ ထည့်ရန်', url: `https://t.me/${bot.bot_username}?startgroup=true` }
                      ]]
                    }
                  }),
                });
              }
              continue;
            }

            // LEARNING: If this is a reply to another message, learn the Q&A pair
            if (msg.reply_to_message && msg.reply_to_message.text) {
              const triggerText = msg.reply_to_message.text;
              const responseText = text;

              // Don't learn from bot's own messages being replied to
              if (msg.reply_to_message.from?.is_bot) continue;

              // Check if this exact pair already exists
              const { data: existing } = await supabase
                .from('trigger_responses')
                .select('id')
                .eq('bot_id', bot.id)
                .eq('trigger_text', triggerText)
                .eq('response_text', responseText)
                .limit(1);

              if (!existing || existing.length === 0) {
                await supabase
                  .from('trigger_responses')
                  .insert({
                    bot_id: bot.id,
                    trigger_text: triggerText,
                    response_text: responseText,
                  });

                console.log(`Bot ${bot.bot_username} learned: "${triggerText}" -> "${responseText}"`);
              }
              continue;
            }

            // RESPONDING: Check if we have a response for this message
            const { data: responses } = await supabase
              .from('trigger_responses')
              .select('response_text')
              .eq('bot_id', bot.id)
              .eq('trigger_text', text)
              .order('created_at', { ascending: true });

            if (responses && responses.length > 0) {
              // Get or create pointer
              const { data: pointerData } = await supabase
                .from('trigger_pointers')
                .select('pointer')
                .eq('bot_id', bot.id)
                .eq('trigger_text', text)
                .single();

              let currentPointer = pointerData?.pointer || 0;
              if (currentPointer >= responses.length) currentPointer = 0;

              const selectedResponse = responses[currentPointer].response_text;

              // Send response
              await fetch(`https://api.telegram.org/bot${bot.api_key}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: chatId,
                  text: selectedResponse,
                  reply_to_message_id: msg.message_id,
                }),
              });

              // Update pointer (round-robin)
              const nextPointer = (currentPointer + 1) % responses.length;
              await supabase
                .from('trigger_pointers')
                .upsert({
                  bot_id: bot.id,
                  trigger_text: text,
                  pointer: nextPointer,
                }, { onConflict: 'bot_id,trigger_text' });

              console.log(`Bot ${bot.bot_username} replied to "${text}" with "${selectedResponse}" (${currentPointer + 1}/${responses.length})`);
            }

            totalProcessed++;
          } catch (err) {
            console.error('Error processing message:', err);
          }
        }

        // Update offset
        const newOffset = Math.max(...updates.map((u: any) => u.update_id)) + 1;
        stateMap.set(bot.id, newOffset);
        await supabase
          .from('bot2_states')
          .update({ update_offset: newOffset, updated_at: new Date().toISOString() })
          .eq('bot_id', bot.id);
      } catch (err) {
        console.error(`Error polling bot ${bot.bot_username}:`, err);
      }
    }

    // If no updates from any bot, wait a bit before next round
    if (!anyUpdates) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: totalProcessed, bots: bots.length }), { headers: corsHeaders });
});
