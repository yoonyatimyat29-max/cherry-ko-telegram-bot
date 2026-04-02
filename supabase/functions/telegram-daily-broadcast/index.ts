import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TELEGRAM_TIMEOUT_MS = 10_000;
const BATCH_SIZE = 30;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BROADCAST_TEXT = 'ကျွန်တော်တို့ရဲ့ Group ကို အားလုံး joinပေးထားဖို့ မေတ္တာရပ်ခံပါတယ်ရှင် 🙏 ❤️‍🔥';

const FIXED_BUTTONS = [
  [{ text: 'The Bot Bar 🤖', url: 'https://t.me/Cherry_Ko_official' }],
  [{ text: 'official Group Join ပေးပါ', url: 'https://t.me/HeartopiaGroups' }],
  [{ text: '𝐒𝐭𝐚𝐫𝐝𝐮𝐬𝐭 𝐋𝐨𝐯𝐞 ᰔ', url: 'https://t.me/Stardust_Love2026' }],
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
  // Fetch ALL chats (including inactive) to reach every user who ever started the bot
  const allChats: any[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data: chats, error } = await supabase
      .from('bot_chats')
      .select('chat_id, chat_title, chat_type, chat_username')
      .eq('bot_id', bot.id)
      .range(from, from + pageSize - 1);

    if (error || !chats?.length) break;
    allChats.push(...chats);
    if (chats.length < pageSize) break;
    from += pageSize;
  }

  if (!allChats.length) return 0;

  const groupChats = allChats.filter((c: any) => c.chat_type !== 'private');
  const privateChats = allChats.filter((c: any) => c.chat_type === 'private');

  console.log(`@${bot.bot_username}: ${groupChats.length} groups, ${privateChats.length} private chats`);

  const sendJobs: Array<{ chatId: number; keyboard: any[][] }> = [];

  // Group chats: fixed buttons + current group's own link only
  for (const chat of groupChats) {
    const keyboard = [...FIXED_BUTTONS];
    if (chat.chat_username) {
      keyboard.push([{ text: `💬 ${chat.chat_title || chat.chat_username}`, url: `https://t.me/${chat.chat_username}` }]);
    }
    sendJobs.push({ chatId: chat.chat_id, keyboard });
  }

  // Private chats: fixed buttons only (no group links)
  for (const chat of privateChats) {
    sendJobs.push({ chatId: chat.chat_id, keyboard: [...FIXED_BUTTONS] });
  }

  return sendInBatches(bot.api_key, bot.bot_username, sendJobs, BATCH_SIZE);
}

async function sendInBatches(
  apiKey: string,
  botUsername: string,
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

    if (i + chunkSize < jobs.length) {
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  console.log(`@${botUsername}: broadcast sent to ${sent}/${jobs.length}`);
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
