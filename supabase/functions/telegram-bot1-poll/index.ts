import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GATEWAY_URL = 'https://connector-gateway.lovable.dev/telegram';
const MAX_UPDATES_PER_RUN = 25;
const TELEGRAM_GATEWAY_TIMEOUT_MS = 10_000;
const BOT_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]{30,}$/;
const START_COMMAND_REGEX = /^\/start(?:@\w+)?(?:\s|$)/i;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY is not configured');

  const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY');
  if (!TELEGRAM_API_KEY) throw new Error('TELEGRAM_API_KEY is not configured');

  const requestBody = await readJsonBody(req);
  const isWebhookUpdate = Number.isFinite(Number(requestBody?.update_id));
  const shouldPoll = requestBody?.manual === true || requestBody?.poll === true;

  if (isWebhookUpdate) {
    const expectedSecret = await deriveTelegramWebhookSecret(TELEGRAM_API_KEY);
    const actualSecret = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!safeEqual(actualSecret, expectedSecret)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }
  } else if (!shouldPoll) {
    return new Response(JSON.stringify({ ok: true, mode: 'webhook', message: 'Bot A polling skipped' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let totalProcessed = 0;
  let updates: any[] = [];

  if (isWebhookUpdate) {
    updates = [requestBody];
  } else {
    const { data: state, error: stateErr } = await supabase
      .from('bot1_state')
      .select('update_offset')
      .eq('id', 1)
      .single();

    if (stateErr) {
      return new Response(JSON.stringify({ error: stateErr.message }), { status: 500, headers: corsHeaders });
    }

    const currentOffset = state.update_offset;

    const data = await callGateway('getUpdates', {
      offset: currentOffset,
      limit: MAX_UPDATES_PER_RUN,
      timeout: 0,
      allowed_updates: ['message', 'callback_query'],
    }, LOVABLE_API_KEY, TELEGRAM_API_KEY);

    if (!data.ok) {
      const description = String(data.description || '').toLowerCase();
      if (String(data.error_code) === '409' && description.includes('webhook')) {
        console.log('Bot 1 webhook is active; polling skipped');
        return new Response(JSON.stringify({ ok: true, mode: 'webhook' }), { headers: corsHeaders });
      }
      if (String(data.error_code) === '409') {
        console.log('Bot 1 polling overlapped, skipping');
        return new Response(JSON.stringify({ ok: true, message: 'Polling overlap skipped' }), { headers: corsHeaders });
      }
      console.error('Telegram gateway error:', data);
      return new Response(JSON.stringify({ error: data }), { status: 502, headers: corsHeaders });
    }

    updates = data.result ?? [];
  }

  if (updates.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  for (const update of updates) {
      try {
        if (update.callback_query) {
          const cb = update.callback_query;
          const cbChatId = cb.message.chat.id;
          const cbData = cb.data || '';

          await callGateway('answerCallbackQuery', { callback_query_id: cb.id }, LOVABLE_API_KEY, TELEGRAM_API_KEY);

          if (cbData === 'create_bot') {
            await supabase
              .from('bot1_conversations')
              .upsert({ chat_id: cbChatId, state: 'waiting_api_key', updated_at: new Date().toISOString() }, { onConflict: 'chat_id' });

            await callGateway('sendMessage', {
              chat_id: cbChatId,
              text: '🔑 ကျေးဇူးပြု၍ @BotFather ထံမှ ရရှိသော Bot API Key ကို ပေးပို့ပါ။\n\n@BotFather ကို /newbot လို့ပို့ပြီး Bot တစ်ခုဖန်တီးပါ။ ပြီးရင် API Key ကို ဒီမှာ ပေးပို့ပါ။',
            }, LOVABLE_API_KEY, TELEGRAM_API_KEY);

          } else if (cbData === 'list_bots') {
            const { data: myBots } = await supabase
              .from('bots')
              .select('id, bot_username, bot_name, is_active, created_at, start_link')
              .eq('owner_chat_id', cbChatId)
              .order('created_at', { ascending: true });

            if (!myBots || myBots.length === 0) {
              await callGateway('sendMessage', {
                chat_id: cbChatId,
                text: '📭 သင့်မှာ ဖန်တီးထားတဲ့ Bot မရှိသေးပါ။',
                reply_markup: { inline_keyboard: [[{ text: '🆕 Bot ဖန်တီးရန်', callback_data: 'create_bot' }]] },
              }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            } else {
              let listText = `📋 သင့် Bot များ (${myBots.length} ခု):\n\n`;
              const keyboard: any[][] = [];

              for (let i = 0; i < myBots.length; i++) {
                const b = myBots[i];
                const status = b.is_active ? '🟢' : '🔴';
                const linkStatus = b.start_link ? ' 🔗' : '';
                listText += `${i + 1}. ${status} @${b.bot_username || b.bot_name || 'Unknown'}${linkStatus}\n`;
                keyboard.push([
                  { text: `⚙️ @${b.bot_username || b.bot_name}`, callback_data: `manage_bot:${b.id}` },
                ]);
              }

              keyboard.push([{ text: '🔙 နောက်သို့', callback_data: 'back_to_menu' }]);

              await callGateway('sendMessage', {
                chat_id: cbChatId,
                text: listText,
                reply_markup: { inline_keyboard: keyboard },
              }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            }

          } else if (cbData.startsWith('manage_bot:')) {
            const botId = cbData.replace('manage_bot:', '');
            const { data: bot } = await supabase
              .from('bots')
              .select('id, bot_username, bot_name, owner_chat_id, is_active')
              .eq('id', botId)
              .single();

            if (!bot || String(bot.owner_chat_id) !== String(cbChatId)) {
              await callGateway('sendMessage', { chat_id: cbChatId, text: '❌ ဒီ Bot ကို စီမံခွင့်မရှိပါ။' }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            } else {
              const name = bot.bot_username || bot.bot_name || 'Unknown';
              const status = bot.is_active ? '🟢 Active' : '🔴 Inactive';

              // Fetch bot_links
              const { data: links } = await supabase
                .from('bot_links')
                .select('id, link_title, link_url')
                .eq('bot_id', botId)
                .order('created_at', { ascending: true });

              let linkInfo = '';
              if (links && links.length > 0) {
                linkInfo = '\n\n🔗 Links:\n' + links.map((l: any, i: number) => `${i + 1}. ${l.link_title} - ${l.link_url}`).join('\n');
              } else {
                linkInfo = '\n\n🔗 Link: မထည့်ရသေးပါ';
              }

              const keyboard: any[][] = [];

              keyboard.push([{ text: '➕ Link ထည့်ရန်', callback_data: `add_link:${bot.id}` }]);

              if (links && links.length > 0) {
                keyboard.push([{ text: '🗑 Link ဖျက်ရန်', callback_data: `list_remove_links:${bot.id}` }]);
              }

              if (bot.is_active) {
                keyboard.push([{ text: '🗑 Bot ဖျက်ရန်', callback_data: `delete_bot:${bot.id}` }]);
              } else {
                keyboard.push([{ text: '✅ ပြန် Activate လုပ်ရန်', callback_data: `reactivate_bot:${bot.id}` }]);
              }

              keyboard.push([{ text: '🔙 Bot List', callback_data: 'list_bots' }]);

              await callGateway('sendMessage', {
                chat_id: cbChatId,
                text: `⚙️ @${name}\nStatus: ${status}${linkInfo}`,
                reply_markup: { inline_keyboard: keyboard },
              }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            }

          } else if (cbData.startsWith('add_link:')) {
            const botId = cbData.replace('add_link:', '');
            const { data: bot } = await supabase
              .from('bots')
              .select('id, owner_chat_id, bot_username')
              .eq('id', botId)
              .single();

            if (!bot || String(bot.owner_chat_id) !== String(cbChatId)) {
              await callGateway('sendMessage', { chat_id: cbChatId, text: '❌ ခွင့်မရှိပါ။' }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            } else {
              await supabase
                .from('bot1_conversations')
                .upsert({ chat_id: cbChatId, state: `waiting_link_title:${botId}`, updated_at: new Date().toISOString() }, { onConflict: 'chat_id' });

              await callGateway('sendMessage', {
                chat_id: cbChatId,
                text: `🔗 @${bot.bot_username} အတွက် Button Title ကို ရိုက်ထည့်ပါ။\n\nဥပမာ: Official Group`,
              }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            }

          } else if (cbData.startsWith('list_remove_links:')) {
            const botId = cbData.replace('list_remove_links:', '');
            const { data: bot } = await supabase
              .from('bots')
              .select('id, owner_chat_id')
              .eq('id', botId)
              .single();

            if (!bot || String(bot.owner_chat_id) !== String(cbChatId)) {
              await callGateway('sendMessage', { chat_id: cbChatId, text: '❌ ခွင့်မရှိပါ။' }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            } else {
              const { data: links } = await supabase
                .from('bot_links')
                .select('id, link_title, link_url')
                .eq('bot_id', botId)
                .order('created_at', { ascending: true });

              if (!links || links.length === 0) {
                await callGateway('sendMessage', {
                  chat_id: cbChatId,
                  text: '📭 ဖျက်ရန် Link မရှိပါ။',
                  reply_markup: { inline_keyboard: [[{ text: '🔙 Bot စီမံရန်', callback_data: `manage_bot:${botId}` }]] },
                }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
              } else {
                const keyboard = links.map((l: any) => [{ text: `❌ ${l.link_title}`, callback_data: `rm_link:${l.id}:${botId}` }]);
                keyboard.push([{ text: '🔙 Bot စီမံရန်', callback_data: `manage_bot:${botId}` }]);

                await callGateway('sendMessage', {
                  chat_id: cbChatId,
                  text: '🗑 ဖျက်ချင်တဲ့ Link ကို နှိပ်ပါ:',
                  reply_markup: { inline_keyboard: keyboard },
                }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
              }
            }

          } else if (cbData.startsWith('rm_link:')) {
            const parts = cbData.replace('rm_link:', '').split(':');
            const linkId = parts[0];
            const botId = parts[1];

            await supabase.from('bot_links').delete().eq('id', linkId);
            await callGateway('sendMessage', {
              chat_id: cbChatId,
              text: '✅ Link ဖျက်ပြီးပါပြီ။',
              reply_markup: { inline_keyboard: [[{ text: '🔙 Bot စီမံရန်', callback_data: `manage_bot:${botId}` }]] },
            }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
          } else if (cbData.startsWith('reactivate_bot:')) {
            const botId = cbData.replace('reactivate_bot:', '');
            const { data: bot } = await supabase
              .from('bots')
              .select('id, owner_chat_id, bot_username, api_key')
              .eq('id', botId)
              .single();

            if (!bot || String(bot.owner_chat_id) !== String(cbChatId)) {
              await callGateway('sendMessage', { chat_id: cbChatId, text: '❌ ခွင့်မရှိပါ။' }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            } else {
              await callTelegramDirect(bot.api_key, 'deleteWebhook', { drop_pending_updates: false });
              await supabase.from('bots').update({ is_active: true }).eq('id', botId);
              await supabase.from('bot2_states').upsert({ bot_id: botId, update_offset: 0, updated_at: new Date().toISOString() }, { onConflict: 'bot_id' });

              await callGateway('sendMessage', {
                chat_id: cbChatId,
                text: `✅ @${bot.bot_username} ကို ပြန် activate လုပ်ပြီးပါပြီ!`,
                reply_markup: { inline_keyboard: [[{ text: '🔙 Bot စီမံရန်', callback_data: `manage_bot:${botId}` }]] },
              }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            }

          } else if (cbData.startsWith('delete_bot:')) {
            const botId = cbData.replace('delete_bot:', '');
            const { data: bot } = await supabase
              .from('bots')
              .select('id, bot_username, bot_name, owner_chat_id')
              .eq('id', botId)
              .single();

            if (!bot || String(bot.owner_chat_id) !== String(cbChatId)) {
              await callGateway('sendMessage', { chat_id: cbChatId, text: '❌ ဒီ Bot ကို ဖျက်ခွင့်မရှိပါ။' }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            } else {
              await callGateway('sendMessage', {
                chat_id: cbChatId,
                text: `⚠️ @${bot.bot_username || bot.bot_name} ကို ဖျက်မှာ သေချာပါသလား?`,
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '✅ ဖျက်မယ်', callback_data: `confirm_delete:${botId}` }, { text: '❌ မဖျက်ဘူး', callback_data: `manage_bot:${botId}` }],
                  ],
                },
              }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            }

          } else if (cbData.startsWith('confirm_delete:')) {
            const botId = cbData.replace('confirm_delete:', '');
            const { data: bot } = await supabase
              .from('bots')
              .select('id, bot_username, bot_name, owner_chat_id')
              .eq('id', botId)
              .single();

            if (!bot || String(bot.owner_chat_id) !== String(cbChatId)) {
              await callGateway('sendMessage', { chat_id: cbChatId, text: '❌ ဒီ Bot ကို ဖျက်ခွင့်မရှိပါ။' }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            } else {
              // Delete related data first, then the bot itself
              await supabase.from('trigger_pointers').delete().eq('bot_id', botId);
              await supabase.from('bot2_states').delete().eq('bot_id', botId);
              await supabase.from('bots').delete().eq('id', botId);
              await callGateway('sendMessage', {
                chat_id: cbChatId,
                text: `🗑 @${bot.bot_username || bot.bot_name} ကို ဖျက်ပြီးပါပြီ။`,
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '📋 Bot များ ကြည့်ရန်', callback_data: 'list_bots' }, { text: '🆕 Bot ဖန်တီးရန်', callback_data: 'create_bot' }],
                  ],
                },
              }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            }

          } else if (cbData === 'back_to_menu') {
            await callGateway('sendMessage', {
              chat_id: cbChatId,
              text: '🤖 ဘာလုပ်ချင်ပါသလဲ?',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🆕 Bot ဖန်တီးရန်', callback_data: 'create_bot' }],
                  [{ text: '📋 Bot များ ကြည့်ရန်', callback_data: 'list_bots' }],
                ],
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

        if (START_COMMAND_REGEX.test(text)) {
          await callGateway('sendMessage', {
            chat_id: chatId,
            text: '🤖 မင်္ဂလာပါ! ဒီ Bot က စကားပြော Bot အသစ်များ ဖန်တီးပေးပါတယ်။',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🆕 Bot ဖန်တီးရန်', callback_data: 'create_bot' }],
                [{ text: '📋 Bot များ ကြည့်ရန်', callback_data: 'list_bots' }],
              ],
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

        if (!convo) { totalProcessed++; continue; }

        // Handle link title input
        if (convo.state.startsWith('waiting_link_title:')) {
          const botId = convo.state.replace('waiting_link_title:', '');
          const title = text;

          if (!title || title.length > 64) {
            await callGateway('sendMessage', {
              chat_id: chatId,
              text: '❌ Title ကို 1-64 characters အတွင်း ထည့်ပါ။',
            }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            totalProcessed++;
            continue;
          }

          // Encode title in state (base64-safe)
          const encodedTitle = btoa(unescape(encodeURIComponent(title)));
          await supabase
            .from('bot1_conversations')
            .update({ state: `waiting_link_url:${botId}:${encodedTitle}`, updated_at: new Date().toISOString() })
            .eq('chat_id', chatId);

          await callGateway('sendMessage', {
            chat_id: chatId,
            text: `✅ Title: "${title}"\n\n🔗 ယခု Link URL ကို ပို့ပေးပါ။\n\nဥပမာ: https://t.me/your_channel`,
          }, LOVABLE_API_KEY, TELEGRAM_API_KEY);

          totalProcessed++;
          continue;
        }

        // Handle link URL input
        if (convo.state.startsWith('waiting_link_url:')) {
          const stateData = convo.state.replace('waiting_link_url:', '');
          const colonIdx = stateData.indexOf(':');
          const botId = stateData.substring(0, colonIdx);
          const encodedTitle = stateData.substring(colonIdx + 1);
          const linkTitle = decodeURIComponent(escape(atob(encodedTitle)));
          const link = text;

          if (!link.startsWith('https://') && !link.startsWith('http://') && !link.startsWith('t.me/')) {
            await callGateway('sendMessage', {
              chat_id: chatId,
              text: '❌ Link format မမှန်ပါ။ https:// သို့မဟုတ် t.me/ နဲ့ စသော link ပေးပို့ပါ။',
            }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
            totalProcessed++;
            continue;
          }

          const finalLink = link.startsWith('t.me/') ? `https://${link}` : link;

          const { data: bot } = await supabase
            .from('bots')
            .select('id, bot_username, owner_chat_id')
            .eq('id', botId)
            .single();

          if (!bot || String(bot.owner_chat_id) !== String(chatId)) {
            await callGateway('sendMessage', { chat_id: chatId, text: '❌ ခွင့်မရှိပါ။' }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
          } else {
            await supabase.from('bot_links').insert({ bot_id: botId, link_url: finalLink, link_title: linkTitle });
            await supabase.from('bot1_conversations').update({ state: 'idle', updated_at: new Date().toISOString() }).eq('chat_id', chatId);

            await callGateway('sendMessage', {
              chat_id: chatId,
              text: `✅ Link ထည့်ပြီးပါပြီ!\n\n📌 ${linkTitle}\n🔗 ${finalLink}`,
              reply_markup: { inline_keyboard: [
                [{ text: '➕ နောက်ထပ် Link ထည့်ရန်', callback_data: `add_link:${botId}` }],
                [{ text: '🔙 Bot စီမံရန်', callback_data: `manage_bot:${botId}` }],
              ] },
            }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
          }

          totalProcessed++;
          continue;
        }

        if (convo.state !== 'waiting_api_key') {
          totalProcessed++;
          continue;
        }

        if (!BOT_TOKEN_REGEX.test(text)) {
          await callGateway('sendMessage', {
            chat_id: chatId,
            text: '❌ API Key format မမှန်ပါ။ @BotFather မှ token ကို copy/paste လုပ်ပြီး ထပ်ပို့ပါ။',
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

        await callTelegramDirect(apiKey, 'deleteWebhook', { drop_pending_updates: false });

        const botInfo = validateData.result;

        const { data: sameKeyBots, error: existingErr } = await supabase
          .from('bots')
          .select('id')
          .eq('api_key', apiKey)
          .order('created_at', { ascending: true });

        if (existingErr) {
          console.error('Error finding existing bot:', existingErr);
          await editOrSendMessage(chatId, processingMsgId, '❌ Bot ဖန်တီးရာတွင် error ဖြစ်နေပါတယ်။', LOVABLE_API_KEY, TELEGRAM_API_KEY);
          totalProcessed++;
          continue;
        }

        let targetBotId: string;
        let isNewBot = false;

        if (sameKeyBots && sameKeyBots.length > 0) {
          targetBotId = sameKeyBots[0].id;
          await supabase.from('bots').update({
            bot_username: botInfo.username,
            bot_name: botInfo.first_name,
            owner_chat_id: chatId,
            is_active: true,
          }).eq('id', targetBotId);

          if (sameKeyBots.length > 1) {
            const duplicateIds = sameKeyBots.slice(1).map((b) => b.id);
            await supabase.from('bots').update({ is_active: false }).in('id', duplicateIds);
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
            await editOrSendMessage(chatId, processingMsgId, '❌ Bot သိမ်းဆည်းရာတွင် အမှားရှိပါသည်။', LOVABLE_API_KEY, TELEGRAM_API_KEY);
            totalProcessed++;
            continue;
          }

          targetBotId = newBot.id;
          isNewBot = true;
        }

        await supabase.from('bot2_states').upsert({
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
            ? `✅ Bot @${botInfo.username} အောင်မြင်စွာ ဖန်တီးပြီးပါပြီ!`
            : `✅ Bot @${botInfo.username} ကို ပြန်လည် activate လုပ်ပြီးပါပြီ!`,
          LOVABLE_API_KEY,
          TELEGRAM_API_KEY,
          {
            inline_keyboard: [
              [{ text: '➕ Group ထဲ ထည့်ရန်', url: `https://t.me/${botInfo.username}?startgroup=true` }],
              [{ text: '⚙️ Bot စီမံရန်', callback_data: `manage_bot:${targetBotId}` }],
              [{ text: '🆕 နောက်ထပ် Bot ဖန်တီးရန်', callback_data: 'create_bot' }],
            ],
          },
        );

        await supabase.from('bot1_conversations').update({ state: 'idle', updated_at: new Date().toISOString() }).eq('chat_id', chatId);
        totalProcessed++;
      } catch (err) {
        console.error('Error processing update:', err);
      }
    }

  if (!isWebhookUpdate) {
    const newOffset = Math.max(...updates.map((u: any) => u.update_id)) + 1;
    await supabase.from('bot1_state').update({ update_offset: newOffset, updated_at: new Date().toISOString() }).eq('id', 1);
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
  timeoutMs = TELEGRAM_GATEWAY_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${GATEWAY_URL}/${method}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'X-Connection-Api-Key': TELEGRAM_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response.json();
  } catch (err) {
    return { ok: false, description: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonBody(req: Request) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

async function deriveTelegramWebhookSecret(telegramApiKey: string): Promise<string> {
  const data = new TextEncoder().encode(`telegram-webhook:${telegramApiKey}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function safeEqual(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function callTelegramDirect(botToken: string, method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function editOrSendMessage(chatId: number, messageId: number | undefined, text: string, LOVABLE_API_KEY: string, TELEGRAM_API_KEY: string, replyMarkup?: unknown) {
  if (messageId) {
    const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await callGateway('editMessageText', body, LOVABLE_API_KEY, TELEGRAM_API_KEY);
    return;
  }
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await callGateway('sendMessage', body, LOVABLE_API_KEY, TELEGRAM_API_KEY);
}
