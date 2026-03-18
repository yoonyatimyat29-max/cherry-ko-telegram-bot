import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GATEWAY_URL = 'https://connector-gateway.lovable.dev/telegram';
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

  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY is not configured');

  const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY');
  if (!TELEGRAM_API_KEY) throw new Error('TELEGRAM_API_KEY is not configured');

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let totalProcessed = 0;

  // Read initial offset
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

    const response = await fetch(`${GATEWAY_URL}/getUpdates`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'X-Connection-Api-Key': TELEGRAM_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        offset: currentOffset,
        timeout,
        allowed_updates: ['message', 'callback_query'],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Telegram API error:', data);
      return new Response(JSON.stringify({ error: data }), { status: 502, headers: corsHeaders });
    }

    const updates = data.result ?? [];
    if (updates.length === 0) continue;

    for (const update of updates) {
      try {
        // Handle callback query (button press)
        if (update.callback_query) {
          const cb = update.callback_query;
          if (cb.data === 'create_bot') {
            // Set conversation state to waiting for API key
            await supabase
              .from('bot1_conversations')
              .upsert({
                chat_id: cb.message.chat.id,
                state: 'waiting_api_key',
                updated_at: new Date().toISOString(),
              }, { onConflict: 'chat_id' });

            // Answer callback query
            await fetch(`${GATEWAY_URL}/answerCallbackQuery`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${LOVABLE_API_KEY}`,
                'X-Connection-Api-Key': TELEGRAM_API_KEY,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ callback_query_id: cb.id }),
            });

            // Ask for API key
            await fetch(`${GATEWAY_URL}/sendMessage`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${LOVABLE_API_KEY}`,
                'X-Connection-Api-Key': TELEGRAM_API_KEY,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                chat_id: cb.message.chat.id,
                text: '🔑 ကျေးဇူးပြု၍ @BotFather ထံမှ ရရှိသော Bot API Key ကို ပေးပို့ပါ။\n\n@BotFather ကို /newbot လို့ပို့ပြီး Bot တစ်ခုဖန်တီးပါ။ ပြီးရင် API Key ကို ဒီမှာ ပေးပို့ပါ။',
              }),
            });
          }
          totalProcessed++;
          continue;
        }

        // Handle messages
        if (update.message) {
          const msg = update.message;
          const chatId = msg.chat.id;
          const text = msg.text || '';

          // Handle /start command
          if (text === '/start') {
            await fetch(`${GATEWAY_URL}/sendMessage`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${LOVABLE_API_KEY}`,
                'X-Connection-Api-Key': TELEGRAM_API_KEY,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                chat_id: chatId,
                text: '🤖 မင်္ဂလာပါ! ဒီ Bot က စကားပြော Bot အသစ်များ ဖန်တီးပေးပါတယ်။\n\nBot ဖန်တီးရန် အောက်က Button ကို နှိပ်ပါ။',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🆕 Bot ဖန်တီးရန်', callback_data: 'create_bot' }
                  ]]
                }
              }),
            });
            totalProcessed++;
            continue;
          }

          // Check if user is in "waiting for API key" state
          const { data: convo } = await supabase
            .from('bot1_conversations')
            .select('state')
            .eq('chat_id', chatId)
            .single();

          if (convo?.state === 'waiting_api_key' && text.includes(':')) {
            // Validate the API key by calling getMe
            const processingMsg = await fetch(`${GATEWAY_URL}/sendMessage`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${LOVABLE_API_KEY}`,
                'X-Connection-Api-Key': TELEGRAM_API_KEY,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                chat_id: chatId,
                text: '⏳ Bot API Key ကို စစ်ဆေးနေပါသည်...',
              }),
            });
            const processingData = await processingMsg.json();
            const processingMsgId = processingData.result?.message_id;

            // Validate by calling Telegram API directly with the user's bot token
            const validateResp = await fetch(`https://api.telegram.org/bot${text}/getMe`);
            const validateData = await validateResp.json();

            if (validateData.ok) {
              const botInfo = validateData.result;

              // Save bot to database
              const { data: newBot, error: botErr } = await supabase
                .from('bots')
                .insert({
                  api_key: text,
                  bot_username: botInfo.username,
                  bot_name: botInfo.first_name,
                  owner_chat_id: chatId,
                })
                .select()
                .single();

              if (botErr) {
                console.error('Error saving bot:', botErr);
                await editMessage(chatId, processingMsgId, '❌ Bot သိမ်းဆည်းရာတွင် အမှားရှိပါသည်။ ထပ်စမ်းပါ။');
              } else {
                // Create bot2 polling state
                await supabase
                  .from('bot2_states')
                  .insert({ bot_id: newBot.id, update_offset: 0 });

                // Set the bot's start message
                await fetch(`https://api.telegram.org/bot${text}/setMyCommands`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    commands: [{ command: 'start', description: 'Bot ကို စတင်ပါ' }],
                  }),
                });

                // Edit processing message to success
                await editMessage(chatId, processingMsgId,
                  `✅ Bot @${botInfo.username} အောင်မြင်စွာ ဖန်တီးပြီးပါပြီ!\n\n🧠 ဒီ Bot က Group ထဲမှာ စကားပြောသင်ယူပါလိမ့်မယ်။\n\nGroup ထဲထည့်ရန် အောက်က Button ကို နှိပ်ပါ။`,
                  {
                    inline_keyboard: [[
                      { text: '➕ Group ထဲ ထည့်ရန်', url: `https://t.me/${botInfo.username}?startgroup=true` }
                    ], [
                      { text: '🆕 နောက်ထပ် Bot ဖန်တီးရန်', callback_data: 'create_bot' }
                    ]]
                  }
                );

                // Reset conversation state
                await supabase
                  .from('bot1_conversations')
                  .update({ state: 'idle', updated_at: new Date().toISOString() })
                  .eq('chat_id', chatId);
              }
            } else {
              await editMessage(chatId, processingMsgId, '❌ API Key မမှန်ပါ။ @BotFather ထံမှ မှန်ကန်သော API Key ကို ပေးပို့ပါ။');
            }
          }
          totalProcessed++;
        }
      } catch (err) {
        console.error('Error processing update:', err);
      }
    }

    // Advance offset
    const newOffset = Math.max(...updates.map((u: any) => u.update_id)) + 1;
    await supabase
      .from('bot1_state')
      .update({ update_offset: newOffset, updated_at: new Date().toISOString() })
      .eq('id', 1);
    currentOffset = newOffset;
  }

  return new Response(JSON.stringify({ ok: true, processed: totalProcessed }), { headers: corsHeaders });

  // Helper function to edit messages
  async function editMessage(chatId: number, messageId: number, text: string, replyMarkup?: any) {
    const body: any = { chat_id: chatId, message_id: messageId, text };
    if (replyMarkup) body.reply_markup = replyMarkup;

    await fetch(`${GATEWAY_URL}/editMessageText`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'X-Connection-Api-Key': TELEGRAM_API_KEY!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }
});
