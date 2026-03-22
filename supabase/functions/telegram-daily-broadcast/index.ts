import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BROADCAST_TEXT = 'ကျွန်တော်တို့ရဲ့ Group ကို အားလုံး joinပေးထားဖို့ မေတ္တာရပ်ခံပါတယ်ရှင် 🙏 ❤️‍🔥';

const FIXED_BUTTONS = [
  [{ text: '🏠 official Group Join ပေးပါ', url: 'https://t.me/HeartopiaGroups' }],
  [{ text: '🤖 The Bot Bar', url: 'https://t.me/Cherry_Ko_official' }],
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

  let totalSent = 0;

  for (const bot of bots) {
    const { data: chats } = await supabase
      .from('bot_chats')
      .select('chat_id, chat_title, chat_type, chat_username')
      .eq('bot_id', bot.id)
      .eq('is_active', true);

    if (!chats?.length) continue;

    const groupChats = chats.filter((c: any) => c.chat_type !== 'private');
    const privateChats = chats.filter((c: any) => c.chat_type === 'private');

    // Group link buttons (for group broadcasts only)
    const groupLinkButtons = groupChats
      .filter((g: any) => g.chat_username)
      .map((g: any) => [{ text: `💬 ${g.chat_title || g.chat_username}`, url: `https://t.me/${g.chat_username}` }]);

    // Send to groups (include other group links)
    for (const chat of groupChats) {
      try {
        const keyboard = [...FIXED_BUTTONS];
        for (const gb of groupLinkButtons) {
          // Don't include link to the current group
          if (chat.chat_username && gb[0].url.includes(chat.chat_username)) continue;
          keyboard.push(gb);
        }
        await callTelegram(bot.api_key, 'sendMessage', {
          chat_id: chat.chat_id,
          text: BROADCAST_TEXT,
          reply_markup: { inline_keyboard: keyboard },
        });
        totalSent++;
      } catch (err) {
        console.error(`Broadcast to group ${chat.chat_id} failed:`, err);
      }
    }

    // Send to private users (only fixed buttons, no group links)
    for (const chat of privateChats) {
      try {
        await callTelegram(bot.api_key, 'sendMessage', {
          chat_id: chat.chat_id,
          text: BROADCAST_TEXT,
          reply_markup: { inline_keyboard: [...FIXED_BUTTONS] },
        });
        totalSent++;
      } catch (err) {
        console.error(`Broadcast to user ${chat.chat_id} failed:`, err);
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, sent: totalSent }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

async function callTelegram(apiKey: string, method: string, payload: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${apiKey}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}
