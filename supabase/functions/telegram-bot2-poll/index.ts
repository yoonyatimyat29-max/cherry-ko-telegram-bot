import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MAX_RUNTIME_MS = 55_000;
const MIN_REMAINING_MS = 5_000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type ContentKind = 'text' | 'sticker';

type ParsedContent = {
  kind: ContentKind;
  value: string;
};

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
    .select('id, api_key, bot_username')
    .eq('is_active', true);

  if (botsErr || !bots?.length) {
    return new Response(JSON.stringify({ ok: true, message: 'No active bots', error: botsErr?.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let totalProcessed = 0;

  const { data: states } = await supabase
    .from('bot2_states')
    .select('bot_id, update_offset');

  const stateMap = new Map((states || []).map((s) => [s.bot_id, s.update_offset]));

  while (true) {
    const elapsed = Date.now() - startTime;
    const remainingMs = MAX_RUNTIME_MS - elapsed;
    if (remainingMs < MIN_REMAINING_MS) break;

    let anyUpdates = false;

    for (const bot of bots) {
      const offset = stateMap.get(bot.id) || 0;

      try {
        const data = await callTelegram(bot.api_key, 'getUpdates', {
          offset,
          timeout: 1,
          allowed_updates: ['message'],
        });

        if (!data.ok) {
          if (data.error_code === 409) {
            const webhookResult = await callTelegram(bot.api_key, 'deleteWebhook', { drop_pending_updates: false });
            if (webhookResult.ok) {
              console.log(`Disabled webhook for @${bot.bot_username} and switched to polling`);
            } else {
              console.error(`Failed to disable webhook for @${bot.bot_username}:`, webhookResult);
            }
          } else {
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
            if (!msg || msg.from?.is_bot) continue;

            const incomingContent = parseContentFromMessage(msg);
            if (!incomingContent) continue;

            if (msg.reply_to_message && !msg.reply_to_message.from?.is_bot) {
              const triggerContent = parseContentFromMessage(msg.reply_to_message);

              if (triggerContent) {
                const triggerKey = encodeContent(triggerContent);
                const responseKey = encodeContent(incomingContent);

                const { data: existing, error: existingErr } = await supabase
                  .from('trigger_responses')
                  .select('id')
                  .eq('trigger_text', triggerKey)
                  .eq('response_text', responseKey)
                  .limit(1);

                if (existingErr) {
                  console.error('Error checking existing learning pair:', existingErr);
                } else if (!existing || existing.length === 0) {
                  const { error: insertErr } = await supabase
                    .from('trigger_responses')
                    .insert({
                      bot_id: bot.id,
                      trigger_text: triggerKey,
                      response_text: responseKey,
                    });

                  if (insertErr) {
                    console.error('Error inserting learning pair:', insertErr);
                  } else {
                    console.log(`Bot @${bot.bot_username} learned global pair: "${triggerKey}" -> "${responseKey}"`);
                  }
                }
              }

              totalProcessed++;
              continue;
            }

            const triggerCandidates = buildTriggerCandidates(incomingContent, msg.text);

            const { data: responses, error: responsesErr } = await supabase
              .from('trigger_responses')
              .select('trigger_text, response_text, created_at')
              .in('trigger_text', triggerCandidates)
              .order('created_at', { ascending: true });

            if (responsesErr) {
              console.error('Error loading responses:', responsesErr);
              totalProcessed++;
              continue;
            }

            if (responses && responses.length > 0) {
              let selectedGroup: Array<{ trigger_text: string; response_text: string }> = [];
              let pointerKey = triggerCandidates[0];

              for (const candidate of triggerCandidates) {
                const group = responses.filter((r) => r.trigger_text === candidate);
                if (group.length > 0) {
                  selectedGroup = group;
                  pointerKey = candidate;
                  break;
                }
              }

              if (selectedGroup.length > 0) {
                const { data: pointerData } = await supabase
                  .from('trigger_pointers')
                  .select('pointer')
                  .eq('bot_id', bot.id)
                  .eq('trigger_text', pointerKey)
                  .single();

                let currentPointer = pointerData?.pointer || 0;
                if (currentPointer >= selectedGroup.length) currentPointer = 0;

                const selectedResponse = decodeContent(selectedGroup[currentPointer].response_text);

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

                const nextPointer = (currentPointer + 1) % selectedGroup.length;
                await supabase
                  .from('trigger_pointers')
                  .upsert({
                    bot_id: bot.id,
                    trigger_text: pointerKey,
                    pointer: nextPointer,
                  }, { onConflict: 'bot_id,trigger_text' });

                console.log(`Bot @${bot.bot_username} replied using global knowledge for "${pointerKey}"`);
              }
            }

            totalProcessed++;
          } catch (err) {
            console.error('Error processing message:', err);
          }
        }

        const newOffset = Math.max(...updates.map((u: any) => u.update_id)) + 1;
        stateMap.set(bot.id, newOffset);

        await supabase
          .from('bot2_states')
          .upsert({
            bot_id: bot.id,
            update_offset: newOffset,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'bot_id' });
      } catch (err) {
        console.error(`Error polling bot ${bot.bot_username}:`, err);
      }
    }

    if (!anyUpdates) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: totalProcessed, bots: bots.length }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

async function callTelegram(
  botApiKey: string,
  method: string,
  payload: Record<string, unknown>,
) {
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
  if (stored.startsWith('text:')) {
    return { kind: 'text', value: stored.slice(5) };
  }

  if (stored.startsWith('sticker:')) {
    return { kind: 'sticker', value: stored.slice(8) };
  }

  return { kind: 'text', value: stored };
}

function buildTriggerCandidates(content: ParsedContent, originalText?: string): string[] {
  const candidates = [encodeContent(content)];

  if (content.kind === 'text') {
    candidates.push(content.value);

    if (typeof originalText === 'string') {
      const trimmedOriginal = originalText.trim();
      if (trimmedOriginal.length > 0 && trimmedOriginal !== content.value) {
        candidates.push(trimmedOriginal);
      }
    }
  }

  return Array.from(new Set(candidates));
}
