import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GATEWAY_URL = 'https://connector-gateway.lovable.dev/telegram';
const MAX_RUNTIME_MS = 55_000;
const MIN_REMAINING_MS = 5_000;
const BOT_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]{30,}$/;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY is not configured');

  const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY');
  if (!TELEGRAM_API_KEY) throw new Error('TELEGRAM_API_KEY is not configured');

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let totalProcessed = 0;

  const { data: state, error: stateErr } = await supabase
    .from('bot1_state')
    .select('update_offset')
    .eq('id', 1)
    .single();

  if (stateErr) {
    return new Response(JSON.stringify({ error: stateErr.message }), { status: 500, headers: corsHeaders });
  }

  let currentOffset = state.update_offset;

  while (true) {
    const elapsed = Date.now() - startTime;
    const remainingMs = MAX_RUNTIME_MS - elapsed;
    if (remainingMs < MIN_REMAINING_MS) break;

    const timeout = Math.min(50, Math.floor(remainingMs / 1000) - 5);
    if (timeout < 1) break;

    const data = await callGateway('getUpdates', {
      offset: currentOffset,
      timeout,
      allowed_updates: ['message', 'callback_query'],
    }, LOVABLE_API_KEY, TELEGRAM_API_KEY);

    if (!data.ok) {
      if (String(data.error_code) === '409') {
        console.log('Bot 1 polling run overlapped with another getUpdates call, skipping this cycle');
        break;
      }

      console.error('Telegram gateway getUpdates error:', data);
      return new Response(JSON.stringify({ error: data }), { status: 502, headers: corsHeaders });
    }

    const updates = data.result ?? [];
    if (updates.length === 0) continue;

    for (const update of updates) {
      try {
        if (update.callback_query) {
          const cb = update.callback_query;
          const cbChatId = cb.message.chat.id;
          const cbData = cb.data || '';

          await callGateway('answerCallbackQuery', {
            callback_query_id: cb.id,
          }, LOVABLE_API_KEY, TELEGRAM_API_KEY);

          if (cbData === 'create_bot') {
            await supabase
              .from('bot1_conversations')
              .upsert({
                chat_id: cbChatId,
                state: 'waiting_api_key',
                updated_at: new Date().toISOString(),
              }, { onConflict: 'chat_id' });

            await callGateway('sendMessage', {
              chat_id: cbChatId,
              text: '🔑 ကျေးဇူးပြု၍ @BotFather ထံမှ ရရှိသော Bot API Key ကို ပေးပို့ပါ။\n\n@BotFather ကို /newbot လို့ပို့ပြီး Bot တစ်ခုဖန်တီးပါ။ ပြီးရင် API Key ကို ဒီမှာ ပေးပို့ပါ။',
            }, LOVABLE_API_KEY, TELEGRAM_API_KEY);

          } else if (cbData === 'list_bots') {
            const { data: myBots } = await supabase
              .from('bots')
              .select('id, bot_username, bot_name, is_active, created_at')
              .eq('owner_chat_id', cbChatId)
              .order('created_at', { ascending: true });

            if (!myBots || myBots.length === 0) {
              await callGateway('sendMessage', {
                chat_id: cbChatId,
                text: '📭 သင့်မှာ ဖန်တီးထားတဲ့ Bot မရှိသေးပါ။',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🆕 Bot ဖန်တီးရန်', callback_data: 'create_bot' },
                  ]],
                },
              }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            } else {
              let listText = `📋 သင့် Bot များ (${myBots.length} ခု):\n\n`;
              const keyboard: any[][] = [];

              for (let i = 0; i < myBots.length; i++) {
                const b = myBots[i];
                const status = b.is_active ? '🟢' : '🔴';
                listText += `${i + 1}. ${status} @${b.bot_username || b.bot_name || 'Unknown'}\n`;
                keyboard.push([
                  { text: `🗑 @${b.bot_username || b.bot_name} ဖျက်ရန်`, callback_data: `delete_bot:${b.id}` },
                ]);
              }

              keyboard.push([
                { text: '🔙 နောက်သို့', callback_data: 'back_to_menu' },
              ]);

              await callGateway('sendMessage', {
                chat_id: cbChatId,
                text: listText,
                reply_markup: { inline_keyboard: keyboard },
              }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            }

          } else if (cbData.startsWith('delete_bot:')) {
            const botId = cbData.replace('delete_bot:', '');

            const { data: botToDelete } = await supabase
              .from('bots')
              .select('id, bot_username, bot_name, owner_chat_id')
              .eq('id', botId)
              .single();

            if (!botToDelete || botToDelete.owner_chat_id !== cbChatId) {
              await callGateway('sendMessage', {
                chat_id: cbChatId,
                text: '❌ ဒီ Bot ကို ဖျက်ခွင့်မရှိပါ။',
              }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            } else {
              await callGateway('sendMessage', {
                chat_id: cbChatId,
                text: `⚠️ @${botToDelete.bot_username || botToDelete.bot_name} ကို ဖျက်မှာ သေချာပါသလား?\n\nသင်ယူထားတဲ့ data များ ဆုံးရှုံးမှာမဟုတ်ပါ။ Bot ကိုသာ ပိတ်ပေးပါမယ်။`,
                reply_markup: {
                  inline_keyboard: [[
                    { text: '✅ ဖျက်မယ်', callback_data: `confirm_delete:${botId}` },
                    { text: '❌ မဖျက်ဘူး', callback_data: 'list_bots' },
                  ]],
                },
              }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            }

          } else if (cbData.startsWith('confirm_delete:')) {
            const botId = cbData.replace('confirm_delete:', '');

            const { data: botToDel } = await supabase
              .from('bots')
              .select('id, bot_username, bot_name, owner_chat_id')
              .eq('id', botId)
              .single();

            if (!botToDel || botToDel.owner_chat_id !== cbChatId) {
              await callGateway('sendMessage', {
                chat_id: cbChatId,
                text: '❌ ဒီ Bot ကို ဖျက်ခွင့်မရှိပါ။',
              }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            } else {
              await supabase
                .from('bots')
                .update({ is_active: false })
                .eq('id', botId);

              await callGateway('sendMessage', {
                chat_id: cbChatId,
                text: `🗑 @${botToDel.bot_username || botToDel.bot_name} ကို ဖျက်ပြီးပါပြီ။`,
                reply_markup: {
                  inline_keyboard: [[
                    { text: '📋 Bot များ ကြည့်ရန်', callback_data: 'list_bots' },
                    { text: '🆕 Bot ဖန်တီးရန်', callback_data: 'create_bot' },
                  ]],
                },
              }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            }

          } else if (cbData === 'back_to_menu') {
            await callGateway('sendMessage', {
              chat_id: cbChatId,
              text: '🤖 ဘာလုပ်ချင်ပါသလဲ?',
              reply_markup: {
                inline_keyboard: [[
                  { text: '🆕 Bot ဖန်တီးရန်', callback_data: 'create_bot' },
                ], [
                  { text: '📋 Bot များ ကြည့်ရန်', callback_data: 'list_bots' },
                ]],
              },
            }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
          }

          totalProcessed++;
          continue;
        }

        if (!update.message) continue;

        const msg = update.message;
        const chatId = msg.chat.id;
        const text = (msg.text || '').trim();

        if (text === '/start') {
          await callGateway('sendMessage', {
            chat_id: chatId,
            text: '🤖 မင်္ဂလာပါ! ဒီ Bot က စကားပြော Bot အသစ်များ ဖန်တီးပေးပါတယ်။',
            reply_markup: {
              inline_keyboard: [[
                { text: '🆕 Bot ဖန်တီးရန်', callback_data: 'create_bot' },
              ], [
                { text: '📋 Bot များ ကြည့်ရန်', callback_data: 'list_bots' },
              ]],
            },
          }, LOVABLE_API_KEY, TELEGRAM_API_KEY);

          totalProcessed++;
          continue;
        }

        const { data: convo } = await supabase
          .from('bot1_conversations')
          .select('state')
          .eq('chat_id', chatId)
          .single();

        if (convo?.state !== 'waiting_api_key') {
          totalProcessed++;
          continue;
        }

        if (!BOT_TOKEN_REGEX.test(text)) {
          await callGateway('sendMessage', {
            chat_id: chatId,
            text: '❌ API Key format မမှန်ပါ။ @BotFather မှ token ကို တိတိကျကျ copy/paste လုပ်ပြီး ထပ်ပို့ပါ။',
          }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
          totalProcessed++;
          continue;
        }

        const processing = await callGateway('sendMessage', {
          chat_id: chatId,
          text: '⏳ Bot API Key ကို စစ်ဆေးပြီး Bot ဖန်တီးနေပါသည်...',
        }, LOVABLE_API_KEY, TELEGRAM_API_KEY);

        const processingMsgId = processing.result?.message_id as number | undefined;
        const apiKey = text;

        const validateData = await callTelegramDirect(apiKey, 'getMe', {});
        if (!validateData.ok) {
          await editOrSendMessage(chatId, processingMsgId, '❌ API Key မမှန်ပါ။ @BotFather ထံမှ မှန်ကန်သော API Key ကို ပေးပို့ပါ။', LOVABLE_API_KEY, TELEGRAM_API_KEY);
          totalProcessed++;
          continue;
        }

        const webhookData = await callTelegramDirect(apiKey, 'deleteWebhook', { drop_pending_updates: false });
        if (!webhookData.ok) {
          await editOrSendMessage(
            chatId,
            processingMsgId,
            '❌ ဒီ Bot မှာ webhook conflict ရှိနေပါတယ်။ BotFather မှ /deleteWebhook ပြီးမှ ထပ်ပို့ပါ။',
            LOVABLE_API_KEY,
            TELEGRAM_API_KEY,
          );
          totalProcessed++;
          continue;
        }

        const botInfo = validateData.result;

        const { data: sameKeyBots, error: existingErr } = await supabase
          .from('bots')
          .select('id')
          .eq('api_key', apiKey)
          .order('created_at', { ascending: true });

        if (existingErr) {
          console.error('Error finding existing bot:', existingErr);
          await editOrSendMessage(chatId, processingMsgId, '❌ Bot ဖန်တီးရာတွင် error ဖြစ်နေပါတယ်။ ထပ်စမ်းပါ။', LOVABLE_API_KEY, TELEGRAM_API_KEY);
          totalProcessed++;
          continue;
        }

        let targetBotId: string;
        let isNewBot = false;

        if (sameKeyBots && sameKeyBots.length > 0) {
          targetBotId = sameKeyBots[0].id;

          const { error: updateErr } = await supabase
            .from('bots')
            .update({
              bot_username: botInfo.username,
              bot_name: botInfo.first_name,
              owner_chat_id: chatId,
              is_active: true,
            })
            .eq('id', targetBotId);

          if (updateErr) {
            console.error('Error updating existing bot:', updateErr);
            await editOrSendMessage(chatId, processingMsgId, '❌ Bot update မအောင်မြင်ပါ။ ထပ်စမ်းပါ။', LOVABLE_API_KEY, TELEGRAM_API_KEY);
            totalProcessed++;
            continue;
          }

          if (sameKeyBots.length > 1) {
            const duplicateIds = sameKeyBots.slice(1).map((b) => b.id);
            await supabase
              .from('bots')
              .update({ is_active: false })
              .in('id', duplicateIds);
          }
        } else {
          const { data: newBot, error: insertErr } = await supabase
            .from('bots')
            .insert({
              api_key: apiKey,
              bot_username: botInfo.username,
              bot_name: botInfo.first_name,
              owner_chat_id: chatId,
              is_active: true,
            })
            .select('id')
            .single();

          if (insertErr || !newBot) {
            console.error('Error saving bot:', insertErr);
            await editOrSendMessage(chatId, processingMsgId, '❌ Bot သိမ်းဆည်းရာတွင် အမှားရှိပါသည်။ ထပ်စမ်းပါ။', LOVABLE_API_KEY, TELEGRAM_API_KEY);
            totalProcessed++;
            continue;
          }

          targetBotId = newBot.id;
          isNewBot = true;
        }

        await supabase
          .from('bot2_states')
          .upsert({
            bot_id: targetBotId,
            update_offset: 0,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'bot_id' });

        await callTelegramDirect(apiKey, 'setMyCommands', {
          commands: [{ command: 'start', description: 'Bot ကို စတင်ပါ' }],
        });

        await editOrSendMessage(
          chatId,
          processingMsgId,
          isNewBot
            ? `✅ Bot @${botInfo.username} အောင်မြင်စွာ ဖန်တီးပြီးပါပြီ!\n\nGroup ထဲထည့်ရန် အောက်က Button ကို နှိပ်ပါ။`
            : `✅ Bot @${botInfo.username} ကို ပြန်လည် activate လုပ်ပြီးပါပြီ!\n\nGroup ထဲထည့်ရန် အောက်က Button ကို နှိပ်ပါ။`,
          LOVABLE_API_KEY,
          TELEGRAM_API_KEY,
          {
            inline_keyboard: [[
              { text: '➕ Group ထဲ ထည့်ရန်', url: `https://t.me/${botInfo.username}?startgroup=true` },
            ], [
              { text: '🆕 နောက်ထပ် Bot ဖန်တီးရန်', callback_data: 'create_bot' },
            ]],
          },
        );

        await supabase
          .from('bot1_conversations')
          .update({ state: 'idle', updated_at: new Date().toISOString() })
          .eq('chat_id', chatId);

        totalProcessed++;
      } catch (err) {
        console.error('Error processing update:', err);
      }
    }

    const newOffset = Math.max(...updates.map((u: any) => u.update_id)) + 1;
    await supabase
      .from('bot1_state')
      .update({ update_offset: newOffset, updated_at: new Date().toISOString() })
      .eq('id', 1);
    currentOffset = newOffset;
  }

  return new Response(JSON.stringify({ ok: true, processed: totalProcessed }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

async function callGateway(
  method: string,
  payload: Record<string, unknown>,
  LOVABLE_API_KEY: string,
  TELEGRAM_API_KEY: string,
) {
  const response = await fetch(`${GATEWAY_URL}/${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LOVABLE_API_KEY}`,
      'X-Connection-Api-Key': TELEGRAM_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return response.json();
}

async function callTelegramDirect(
  botToken: string,
  method: string,
  payload: Record<string, unknown>,
) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return response.json();
}

async function editOrSendMessage(
  chatId: number,
  messageId: number | undefined,
  text: string,
  LOVABLE_API_KEY: string,
  TELEGRAM_API_KEY: string,
  replyMarkup?: unknown,
) {
  if (messageId) {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
    };

    if (replyMarkup) body.reply_markup = replyMarkup;

    await callGateway('editMessageText', body, LOVABLE_API_KEY, TELEGRAM_API_KEY);
    return;
  }

  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;

  await callGateway('sendMessage', body, LOVABLE_API_KEY, TELEGRAM_API_KEY);
}
