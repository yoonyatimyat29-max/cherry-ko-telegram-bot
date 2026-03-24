import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MAX_RUNTIME_MS = 55_000;
const MIN_REMAINING_MS = 5_000;
const TELEGRAM_TIMEOUT_MS = 8_000;
const CHAT_MAP_REFRESH_MS = 15_000;
const REACTION_EMOJIS = ['❤️', '🔥', '👍', '😂', '🎉', '❤️‍🔥', '💯', '😍', '👏', '🤩'];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type ContentKind = 'text' | 'sticker' | 'voice';
type ParsedContent = { kind: ContentKind; value: string };
type BotRow = { id: string; api_key: string; bot_username: string | null; start_link: string | null };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: bots, error: botsErr } = await supabase
    .from('bots')
    .select('id, api_key, bot_username, start_link')
    .eq('is_active', true);

  if (botsErr || !bots?.length) {
    return new Response(JSON.stringify({ ok: true, message: 'No active bots' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: states } = await supabase.from('bot2_states').select('bot_id, update_offset');
  const stateMap = new Map((states || []).map((s: any) => [s.bot_id, s.update_offset]));

  let chatBotMap = await loadChatBotMap(supabase, bots.map((b: BotRow) => b.id));
  let lastChatMapRefresh = Date.now();
  let totalProcessed = 0;

  while (true) {
    const remaining = MAX_RUNTIME_MS - (Date.now() - startTime);
    if (remaining < MIN_REMAINING_MS) break;

    if (Date.now() - lastChatMapRefresh >= CHAT_MAP_REFRESH_MS) {
      chatBotMap = await loadChatBotMap(supabase, bots.map((b: BotRow) => b.id));
      lastChatMapRefresh = Date.now();
    }

    const results = await Promise.all(
      bots.map((bot: BotRow) => pollSingleBot(bot, stateMap, chatBotMap, supabase))
    );

    let anyUpdates = false;
    for (const r of results) {
      totalProcessed += r.processed;
      if (r.processed > 0) anyUpdates = true;
    }

    if (!anyUpdates) {
      await delay(300);
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: totalProcessed, bots: bots.length }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

async function pollSingleBot(
  bot: BotRow,
  stateMap: Map<string, number>,
  chatBotMap: Map<number, string[]>,
  supabase: any,
): Promise<{ processed: number }> {
  let processed = 0;
  const offset = stateMap.get(bot.id) || 0;

  try {
    const data = await callTelegram(bot.api_key, 'getUpdates', {
      offset,
      timeout: 1,
      allowed_updates: ['message'],
    });

    if (!data.ok) {
      if (String(data.error_code) === '409' && String(data.description || '').toLowerCase().includes('webhook')) {
        await callTelegram(bot.api_key, 'deleteWebhook', { drop_pending_updates: false });
      }
      return { processed: 0 };
    }

    const updates = data.result ?? [];
    if (updates.length === 0) return { processed: 0 };
    const highLoad = updates.length >= 15;

    for (const update of updates) {
      try {
        const msg = update.message;
        if (!msg) continue;

        trackChat(supabase, bot.id, msg.chat, chatBotMap);

        // Handle /start in private chat
        if (msg.chat.type === 'private' && msg.text === '/start') {
          await handleStart(bot, msg);
          processed++;
          continue;
        }

        const isFromBot = msg.from?.is_bot;
        const incomingContent = parseContent(msg);

        // Learn from replies (human replies only)
        if (msg.reply_to_message && !isFromBot && incomingContent) {
          const triggerContent = parseContent(msg.reply_to_message);
          if (triggerContent) {
            await learnPair(supabase, bot.id, triggerContent, incomingContent, bot.bot_username);
          }
        }

        // Skip bot messages entirely
        if (isFromBot) continue;

        // Determine turn-taking for groups with multiple bots
        const isGroup = msg.chat.type !== 'private';
        if (isGroup) {
          await hydrateChatBotsForChat(supabase, chatBotMap, msg.chat.id);
          if (!shouldCurrentBotRespond(chatBotMap, bot.id, msg.chat.id, msg.message_id)) continue;
        }

        // React to media/text (only if this bot's turn, or single bot, or private)
        if (msg.photo || msg.video || msg.text || msg.sticker || msg.voice || msg.audio) {
          reactToMessage(bot.api_key, msg.chat.id, msg.message_id);
        }

        // Try to respond if we have content to match
        if (!incomingContent) continue;

        const exactKey = encodeContent(incomingContent);
        await tryRespond(supabase, bot, msg, exactKey, highLoad);
        processed++;
      } catch (err) {
        console.error('Msg error:', err);
      }
    }

    const newOffset = Math.max(...updates.map((u: any) => u.update_id)) + 1;
    stateMap.set(bot.id, newOffset);
    await supabase.from('bot2_states').upsert(
      { bot_id: bot.id, update_offset: newOffset, updated_at: new Date().toISOString() },
      { onConflict: 'bot_id' }
    );
  } catch (err) {
    console.error(`Poll error @${bot.bot_username}:`, err);
  }

  return { processed };
}

async function handleStart(bot: BotRow, msg: any) {
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
}

function trackChat(supabase: any, botId: string, chat: any, chatBotMap: Map<number, string[]>) {
  if (!chat) return;

  const chatId = Number(chat.id);
  if (Number.isFinite(chatId)) {
    const existing = chatBotMap.get(chatId) ?? [];
    if (!existing.includes(botId)) {
      existing.push(botId);
      existing.sort();
      chatBotMap.set(chatId, existing);
    }
  }

  supabase.from('bot_chats').upsert({
    bot_id: botId,
    chat_id: chat.id,
    chat_title: chat.title || chat.first_name || null,
    chat_type: chat.type,
    chat_username: chat.username || null,
    is_active: true,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'bot_id,chat_id' }).then(() => {}).catch(() => {});
}

async function loadChatBotMap(supabase: any, botIds: string[]) {
  const chatBotMap = new Map<number, string[]>();
  if (!botIds.length) return chatBotMap;

  const { data: rows } = await supabase
    .from('bot_chats')
    .select('chat_id, bot_id')
    .in('bot_id', botIds)
    .eq('is_active', true);

  for (const row of rows || []) {
    const chatId = Number(row.chat_id);
    if (!Number.isFinite(chatId)) continue;

    const existing = chatBotMap.get(chatId) ?? [];
    if (!existing.includes(row.bot_id)) {
      existing.push(row.bot_id);
      existing.sort();
      chatBotMap.set(chatId, existing);
    }
  }

  return chatBotMap;
}

async function hydrateChatBotsForChat(supabase: any, chatBotMap: Map<number, string[]>, chatIdRaw: number) {
  const chatId = Number(chatIdRaw);
  if (!Number.isFinite(chatId)) return;
  if (chatBotMap.has(chatId)) return;

  const { data: rows } = await supabase
    .from('bot_chats')
    .select('bot_id')
    .eq('chat_id', chatId)
    .eq('is_active', true);

  const botIds = Array.from(new Set((rows || []).map((r: any) => r.bot_id))).sort();
  chatBotMap.set(chatId, botIds);
}

function shouldCurrentBotRespond(chatBotMap: Map<number, string[]>, currentBotId: string, chatIdRaw: number, messageIdRaw: number) {
  const chatId = Number(chatIdRaw);
  const messageId = Number(messageIdRaw);
  if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) return true;

  const botIds = chatBotMap.get(chatId) || [];
  if (botIds.length <= 1) return true;

  const turnIndex = Math.abs(messageId) % botIds.length;
  return botIds[turnIndex] === currentBotId;
}

async function learnPair(supabase: any, botId: string, trigger: ParsedContent, response: ParsedContent, botUsername: string | null) {
  const triggerKey = encodeContent(trigger);
  const responseKey = encodeContent(response);

  const { data: existing } = await supabase
    .from('trigger_responses')
    .select('id')
    .eq('trigger_text', triggerKey)
    .eq('response_text', responseKey)
    .limit(1);

  if (!existing || existing.length === 0) {
    const { error } = await supabase
      .from('trigger_responses')
      .insert({ bot_id: botId, trigger_text: triggerKey, response_text: responseKey });
    if (!error) {
      console.log(`@${botUsername} learned: "${triggerKey}" -> "${responseKey}"`);
    }
  }
}

async function tryRespond(supabase: any, bot: BotRow, msg: any, exactKey: string, highLoad: boolean) {
  const [{ data: responses }, { data: pointerData }] = await Promise.all([
    supabase
      .from('trigger_responses')
      .select('response_text, created_at')
      .eq('trigger_text', exactKey)
      .order('created_at', { ascending: true }),
    supabase
      .from('trigger_pointers')
      .select('pointer')
      .eq('bot_id', bot.id)
      .eq('trigger_text', exactKey)
      .single(),
  ]);

  if (!responses || responses.length === 0) return;

  let ptr = pointerData?.pointer || 0;
  if (ptr >= responses.length) ptr = 0;

  const selected = decodeContent(responses[ptr].response_text);
  const action = selected.kind === 'sticker' ? 'choose_sticker' : 'typing';
  callTelegram(bot.api_key, 'sendChatAction', { chat_id: msg.chat.id, action }).catch(() => {});
  await delay(highLoad ? 30 + Math.random() * 70 : 80 + Math.random() * 150);

  if (selected.kind === 'sticker') {
    await callTelegram(bot.api_key, 'sendSticker', {
      chat_id: msg.chat.id, sticker: selected.value,
      reply_to_message_id: msg.message_id, allow_sending_without_reply: true,
    });
  } else if (selected.kind === 'voice') {
    await callTelegram(bot.api_key, 'sendVoice', {
      chat_id: msg.chat.id, voice: selected.value,
      reply_to_message_id: msg.message_id, allow_sending_without_reply: true,
    });
  } else {
    await callTelegram(bot.api_key, 'sendMessage', {
      chat_id: msg.chat.id, text: selected.value,
      reply_to_message_id: msg.message_id, allow_sending_without_reply: true,
    });
  }

  const nextPtr = (ptr + 1) % responses.length;
  await supabase.from('trigger_pointers').upsert(
    { bot_id: bot.id, trigger_text: exactKey, pointer: nextPtr },
    { onConflict: 'bot_id,trigger_text' }
  );
  console.log(`@${bot.bot_username} replied for "${exactKey}"`);
}

function reactToMessage(apiKey: string, chatId: number, messageId: number) {
  const emoji = REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
  callTelegram(apiKey, 'setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji }],
  }).catch(() => {});
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

function parseContent(msg: any): ParsedContent | null {
  if (typeof msg?.text === 'string' && msg.text.trim().length > 0) {
    return { kind: 'text', value: msg.text.trim().replace(/\s+/g, ' ').toLocaleLowerCase() };
  }
  if (msg?.sticker?.file_id) {
    return { kind: 'sticker', value: msg.sticker.file_id };
  }
  if (msg?.voice?.file_id) {
    return { kind: 'voice', value: msg.voice.file_id };
  }
  if (msg?.audio?.file_id) {
    return { kind: 'voice', value: msg.audio.file_id };
  }
  return null;
}

function encodeContent(c: ParsedContent): string {
  return `${c.kind}:${c.value}`;
}

function decodeContent(stored: string): ParsedContent {
  if (stored.startsWith('text:')) return { kind: 'text', value: stored.slice(5) };
  if (stored.startsWith('sticker:')) return { kind: 'sticker', value: stored.slice(8) };
  if (stored.startsWith('voice:')) return { kind: 'voice', value: stored.slice(6) };
  return { kind: 'text', value: stored };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
