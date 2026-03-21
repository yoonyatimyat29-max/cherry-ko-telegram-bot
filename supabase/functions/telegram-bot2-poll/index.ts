import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MAX_RUNTIME_MS = 55_000;
const MIN_REMAINING_MS = 5_000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type ContentKind = 'text' | 'sticker';
type ParsedContent = { kind: ContentKind; value: string };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { data: bots, error: botsErr } = await supabase
    .from('bots')
    .select('id, api_key, bot_username, start_link')
    .eq('is_active', true);

  if (botsErr || !bots?.length) {
    return new Response(JSON.stringify({ ok: true, message: 'No active bots', error: botsErr?.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let totalProcessed = 0;

  const { data: states } = await supabase.from('bot2_states').select('bot_id, update_offset');
  const stateMap = new Map((states || []).map((s) => [s.bot_id, s.update_offset]));

  // Cache bot usernames for self-detection
  const botUsernameSet = new Set(bots.map(b => b.bot_username?.toLowerCase()).filter(Boolean));

  while (true) {
    const elapsed = Date.now() - startTime;
    const remainingMs = MAX_RUNTIME_MS - elapsed;
    if (remainingMs < MIN_REMAINING_MS) break;

    let anyUpdates = false;

    for (const bot of bots) {
      if (Date.now() - startTime > MAX_RUNTIME_MS - MIN_REMAINING_MS) break;

      const offset = stateMap.get(bot.id) || 0;

      try {
        const data = await callTelegram(bot.api_key, 'getUpdates', {
          offset,
          timeout: 2,
          allowed_updates: ['message'],
        });

        if (!data.ok) {
          const isConflict = String(data.error_code) === '409';
          const desc = String(data.description || '').toLowerCase();

          if (isConflict && desc.includes('webhook')) {
            const wr = await callTelegram(bot.api_key, 'deleteWebhook', { drop_pending_updates: false });
            if (wr.ok) console.log(`Disabled webhook for @${bot.bot_username}`);
          } else if (!isConflict) {
            console.error(`Bot ${bot.bot_username} API error:`, data);
          }
          continue;
        }

        const updates = data.result ?? [];
        if (updates.length === 0) continue;

        anyUpdates = true;

        for (const update of updates) {
          try {
            const msg = update.message;
            if (!msg) continue;

            // Handle /start command in private chat
            if (msg.chat.type === 'private' && msg.text === '/start') {
              const greeting = '👋 မင်္ဂလာပါ! Group ထဲထည့်ပေးပါ။\n\nGroup ထဲမှာ User တွေ Reply နဲ့ စကားပြန်ပြောပေးမယ်';

              const keyboard: any[][] = [];
              if (bot.start_link) {
                keyboard.push([{ text: '📢 Join ပေးပါရန်', url: bot.start_link }]);
              }
              keyboard.push([{ text: '➕ Group ထဲ ထည့်ရန်', url: `https://t.me/${bot.bot_username}?startgroup=true` }]);

              await callTelegram(bot.api_key, 'sendMessage', {
                chat_id: msg.chat.id,
                text: greeting,
                reply_markup: { inline_keyboard: keyboard },
              });
              totalProcessed++;
              continue;
            }

            // Skip messages from bots (but we still learn from replies TO bot messages)
            const isFromBot = msg.from?.is_bot;
            
            const incomingContent = parseContentFromMessage(msg);
            if (!incomingContent) continue;

            // Learning: from user reply to another message (including bot messages)
            if (msg.reply_to_message && !isFromBot) {
              const triggerContent = parseContentFromMessage(msg.reply_to_message);

              if (triggerContent) {
                const triggerKey = encodeContent(triggerContent);
                const responseKey = encodeContent(incomingContent);

                const { data: existing } = await supabase
                  .from('trigger_responses')
                  .select('id')
                  .eq('trigger_text', triggerKey)
                  .eq('response_text', responseKey)
                  .limit(1);

                if (!existing || existing.length === 0) {
                  const { error: insertErr } = await supabase
                    .from('trigger_responses')
                    .insert({ bot_id: bot.id, trigger_text: triggerKey, response_text: responseKey });

                  if (!insertErr) {
                    console.log(`@${bot.bot_username} learned: "${triggerKey}" -> "${responseKey}"`);
                  }
                }
              }
            }

            // Skip bot messages for response lookup
            if (isFromBot) continue;

            // Response lookup: EXACT match only using encoded content key
            const exactKey = encodeContent(incomingContent);

            const { data: responses } = await supabase
              .from('trigger_responses')
              .select('trigger_text, response_text, created_at')
              .eq('trigger_text', exactKey)
              .order('created_at', { ascending: true });

            if (responses && responses.length > 0) {
              const { data: pointerData } = await supabase
                .from('trigger_pointers')
                .select('pointer')
                .eq('bot_id', bot.id)
                .eq('trigger_text', exactKey)
                .single();

              let currentPointer = pointerData?.pointer || 0;
              if (currentPointer >= responses.length) currentPointer = 0;

              const selectedResponse = decodeContent(responses[currentPointer].response_text);

              // Send typing indicator
              await callTelegram(bot.api_key, 'sendChatAction', {
                chat_id: msg.chat.id,
                action: selectedResponse.kind === 'sticker' ? 'choose_sticker' : 'typing',
              });

              // Small delay to simulate typing
              await new Promise((resolve) => setTimeout(resolve, 800 + Math.random() * 1200));

              if (selectedResponse.kind === 'sticker') {
                await callTelegram(bot.api_key, 'sendSticker', {
                  chat_id: msg.chat.id,
                  sticker: selectedResponse.value,
                  reply_to_message_id: msg.message_id,
                });
              } else {
                await callTelegram(bot.api_key, 'sendMessage', {
                  chat_id: msg.chat.id,
                  text: selectedResponse.value,
                  reply_to_message_id: msg.message_id,
                });
              }

              const nextPointer = (currentPointer + 1) % responses.length;
              await supabase
                .from('trigger_pointers')
                .upsert({ bot_id: bot.id, trigger_text: exactKey, pointer: nextPointer }, { onConflict: 'bot_id,trigger_text' });

              console.log(`@${bot.bot_username} replied for "${exactKey}"`);
            }

            totalProcessed++;
          } catch (err) {
            console.error('Error processing message:', err);
          }
        }

        const newOffset = Math.max(...updates.map((u: any) => u.update_id)) + 1;
        stateMap.set(bot.id, newOffset);

        await supabase.from('bot2_states').upsert({
          bot_id: bot.id,
          update_offset: newOffset,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'bot_id' });
      } catch (err) {
        console.error(`Error polling bot ${bot.bot_username}:`, err);
      }
    }

    if (!anyUpdates) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: totalProcessed, bots: bots.length }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

async function callTelegram(botApiKey: string, method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${botApiKey}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}

function parseContentFromMessage(msg: any): ParsedContent | null {
  if (typeof msg?.text === 'string' && msg.text.trim().length > 0) {
    return { kind: 'text', value: normalizeText(msg.text) };
  }
  if (msg?.sticker?.file_id) {
    return { kind: 'sticker', value: msg.sticker.file_id };
  }
  return null;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function encodeContent(content: ParsedContent): string {
  return `${content.kind}:${content.value}`;
}

function decodeContent(stored: string): ParsedContent {
  if (stored.startsWith('text:')) return { kind: 'text', value: stored.slice(5) };
  if (stored.startsWith('sticker:')) return { kind: 'sticker', value: stored.slice(8) };
  return { kind: 'text', value: stored };
}
