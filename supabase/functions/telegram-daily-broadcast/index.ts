import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TELEGRAM_TIMEOUT_MS = 10_000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BROADCAST_TEXT = 'ကျွန်တော်တို့ရဲ့ Group ကို အားလုံး joinပေးထားဖို့ မေတ္တာရပ်ခံပါတယ်ရှင် 🙏 ❤️‍🔥';

const FIXED_BUTTONS = [
  [{ text: 'The Bot Bar 🤖', url: 'https://t.me/Cherry_Ko_official' }],
  [{ text: 'official Group Join ပေးပါ', url: 'https://t.me/HeartopiaGroups' }],
  [{ text: 'DENSTAR1K 💖', url: 'https://t.me/addlist/pOfGHQLDBPY3ZjM9' }],
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: bots } = await supabase
    .from('bots')
    .select('id, api_key, bot_username')
    .eq('is_active', true);

  if (!bots?.length) {
    return new Response(JSON.stringify({ ok: true, message: 'No active bots' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const totals = await Promise.allSettled(
    bots.map((bot: any) => processBotBroadcast(supabase, bot))
  );

  const sent = totals.reduce((sum, result) => {
    if (result.status === 'fulfilled') return sum + result.value;
    return sum;
  }, 0);

  return new Response(JSON.stringify({ ok: true, sent }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

async function processBotBroadcast(supabase: any, bot: any): Promise<number> {
  const { data: chats } = await supabase
    .from('bot_chats')
    .select('chat_id, chat_title, chat_type, chat_username')
    .eq('bot_id', bot.id)
    .eq('is_active', true);

  if (!chats?.length) return 0;

  const groupChats = chats.filter((c: any) => c.chat_type !== 'private');
  const privateChats = chats.filter((c: any) => c.chat_type === 'private');

  const groupLinkButtons = groupChats
    .filter((g: any) => g.chat_username)
    .map((g: any) => [{ text: `💬 ${g.chat_title || g.chat_username}`, url: `https://t.me/${g.chat_username}` }]);

  const sendJobs: Array<{ chatId: number; keyboard: any[][] }> = [];

  for (const chat of groupChats) {
    const keyboard = [...FIXED_BUTTONS];
    for (const gb of groupLinkButtons) {
      if (chat.chat_username && String(gb[0].url).includes(chat.chat_username)) continue;
      keyboard.push(gb);
    }
    sendJobs.push({ chatId: chat.chat_id, keyboard });
  }

  for (const chat of privateChats) {
    sendJobs.push({ chatId: chat.chat_id, keyboard: [...FIXED_BUTTONS] });
  }

  return sendInBatches(bot.api_key, sendJobs, 20);
}

async function sendInBatches(
  apiKey: string,
  jobs: Array<{ chatId: number; keyboard: any[][] }>,
  chunkSize: number,
): Promise<number> {
  let sent = 0;

  for (let i = 0; i < jobs.length; i += chunkSize) {
    const chunk = jobs.slice(i, i + chunkSize);
    const results = await Promise.allSettled(
      chunk.map((job) =>
        callTelegram(apiKey, 'sendMessage', {
          chat_id: job.chatId,
          text: BROADCAST_TEXT,
          reply_markup: { inline_keyboard: job.keyboard },
        })
      )
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value?.ok) {
        sent++;
      }
    }
  }

  return sent;
}

async function callTelegram(apiKey: string, method: string, payload: Record<string, unknown>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    const res = await fetch(`https://api.telegram.org/bot${apiKey}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, description: text || 'Invalid JSON from Telegram' };
    }
  } catch (err) {
    return { ok: false, description: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}