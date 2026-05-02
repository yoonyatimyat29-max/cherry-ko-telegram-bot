import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MAX_RUNTIME_MS = 50_000;
const MIN_REMAINING_MS = 5_000;
const TELEGRAM_TIMEOUT_MS = 8_000;
const IDLE_DELAY_MS = 250;
const BOT_POLL_CONCURRENCY = 8;
const BROADCAST_PAGE_SIZE = 200;
const BROADCAST_CHUNK_SIZE = 25;
const CACHE_WARM_BATCH_SIZE = 25;
const TELEGRAM_RETRY_ATTEMPTS = 4;
const STALE_REPLY_MAX_AGE_SECONDS = 2 * 60;
const REACTION_SAMPLE_RATE = 0.04;
const REACTION_EMOJIS = ['❤️', '🔥', '👍', '😂', '🎉', '❤️‍🔥', '💯', '😍', '👏', '🤩'];

// Admin Channel - ONLY this channel is allowed to broadcast
const OWNER_CHANNEL_ID = -1003383045115;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type ContentKind = 'text' | 'sticker' | 'voice' | 'text_rich';
type ParsedContent = { kind: ContentKind; value: string; entities?: any[] };
type BotRow = { id: string; api_key: string; bot_username: string | null; start_link: string | null };
// (channel forward jobs removed — broadcasts are now sent immediately)
type BroadcastClaim = { id: string };
type RecipientClaim = { id: string; target_chat_id: number };
type ChatRecord = {
  bot_id: string;
  chat_id: number;
  chat_title: string | null;
  chat_type: string;
  chat_username: string | null;
  is_active: boolean;
  updated_at: string;
};
type PollResult = { processed: number; hadUpdates: boolean };
type LearnedPair = { triggerKey: string; responseKey: string };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const shardConfig = await readShardConfig(req);

  const { data: allBots, error: botsErr } = await supabase
    .from('bots')
    .select('id, api_key, bot_username, start_link')
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  const bots = (allBots || []).filter((_: any, index: number) => index % shardConfig.shards === shardConfig.shard);

  if (botsErr || !bots.length) {
    return new Response(JSON.stringify({ ok: true, message: 'No active bots' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: states } = await supabase.from('bot2_states').select('bot_id, update_offset');
  const stateMap = new Map((states || []).map((state: any) => [state.bot_id, state.update_offset]));
  const chatBotMap = new Map<number, string[]>();
  const responseCache = new Map<string, string[]>();
  const pointerCache = new Map<string, number>();

  let totalProcessed = 0;

  while (true) {
    const remaining = MAX_RUNTIME_MS - (Date.now() - startTime);
    if (remaining < MIN_REMAINING_MS) break;

    let anyUpdates = false;

    for (const batch of chunkArray(bots, BOT_POLL_CONCURRENCY)) {
      const results = await Promise.allSettled(
        batch.map((bot: BotRow) => pollSingleBot(bot, stateMap, chatBotMap, responseCache, pointerCache, supabase))
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          totalProcessed += result.value.processed;
          if (result.value.hadUpdates) anyUpdates = true;
        } else {
          console.error('Bot batch error:', result.reason);
        }
      }

      if (MAX_RUNTIME_MS - (Date.now() - startTime) < MIN_REMAINING_MS) break;
    }

    if (!anyUpdates) {
      await delay(IDLE_DELAY_MS);
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    processed: totalProcessed,
    bots: bots.length,
    shard: shardConfig.shard,
    shards: shardConfig.shards,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

async function pollSingleBot(
  bot: BotRow,
  stateMap: Map<string, number>,
  chatBotMap: Map<number, string[]>,
  responseCache: Map<string, string[]>,
  pointerCache: Map<string, number>,
  supabase: any,
): Promise<PollResult> {
  let processed = 0;
  const offset = stateMap.get(bot.id) || 0;
  let didBroadcast = false;

  try {
    const data = await callTelegram(bot.api_key, 'getUpdates', {
      offset,
      limit: 100,
      timeout: 1,
      allowed_updates: ['message', 'channel_post'],
    });

    if (!data.ok) {
      if (String(data.error_code) === '409' && String(data.description || '').toLowerCase().includes('webhook')) {
        await callTelegram(bot.api_key, 'deleteWebhook', { drop_pending_updates: false });
      } else if (String(data.error_code) === '409') {
        console.warn(`@${bot.bot_username}: getUpdates overlap detected`);
      } else {
        console.error(`@${bot.bot_username}: getUpdates failed`, data);
      }
      return { processed: 0, hadUpdates: false };
    }

    const updates = Array.isArray(data.result) ? data.result : [];
    if (updates.length === 0) {
      return { processed: 0, hadUpdates: false };
    }

    // Handle channel posts — ONLY from Admin Channel, broadcast immediately
    const channelPosts = updates
      .filter((u: any) => u.channel_post)
      .map((u: any) => u.channel_post);

    for (const post of channelPosts) {
      const chatId = Number(post.chat?.id);
      if (chatId === OWNER_CHANNEL_ID) {
        const sent = await broadcastChannelPost(supabase, bot, post);
        if (sent > 0) didBroadcast = true;
      }
      // any other channel → silently ignored
    }

    const messages = updates.map((update: any) => update.message).filter(Boolean);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const freshMessages = messages.filter((message: any) => isMessageFresh(message, nowSeconds));

    if (messages.length > 0 && freshMessages.length === 0 && channelPosts.length === 0) {
      const newOffset = Math.max(...updates.map((update: any) => update.update_id)) + 1;
      stateMap.set(bot.id, newOffset);
      await persistBotOffset(supabase, bot.id, newOffset);
      return { processed: 0, hadUpdates: true };
    }

    const chatRecords = collectChatRecords(bot.id, messages, chatBotMap);
    const learnedPairs = collectLearnedPairs(freshMessages);
    const highLoad = updates.length >= 15 || freshMessages.length < messages.length;

    if (learnedPairs.length > 0) {
      await learnPairsBatch(supabase, bot.id, learnedPairs, bot.bot_username, responseCache);
    }

    const exactKeys: string[] = Array.from(new Set(
      messages
        .filter((message: any) => isMessageFresh(message, nowSeconds))
        .map((message: any) => parseContent(message))
        .filter(Boolean)
        .map((content: ParsedContent | null) => encodeContent(content!))
    ));

    if (exactKeys.length > 0) {
      await warmCaches(supabase, bot.id, exactKeys, responseCache, pointerCache);
    }

    const pointerUpdates = new Map<string, number>();

    for (const update of updates) {
      try {
        const msg = update.message;
        if (!msg) continue;

        if (!isMessageFresh(msg, nowSeconds)) continue;

        if (msg.chat.type === 'private' && isStartCommand(msg.text)) {
          await handleStart(bot, msg);
          processed++;
          continue;
        }

        if (msg.from?.is_bot) continue;

        // Block bot usage in channels (except owner's channel)
        if (msg.chat.type === 'channel') {
          const chatId = Number(msg.chat.id);
          if (chatId !== OWNER_CHANNEL_ID) continue;
        }

        const isGroup = msg.chat.type !== 'private';
        if (isGroup) {
          await hydrateChatBotsForChat(supabase, chatBotMap, msg.chat.id, bot.id);
          if (!shouldCurrentBotRespond(chatBotMap, bot.id, msg.chat.id, msg.message_id)) continue;
        }

        if (msg.photo || msg.video || msg.text || msg.sticker || msg.voice || msg.audio) {
          maybeReactToMessage(bot.api_key, msg.chat.id, msg.message_id);
        }

        const incomingContent = parseContent(msg);
        if (!incomingContent) continue;

        const exactKey = encodeContent(incomingContent);
        const responded = await tryRespond(
          supabase,
          bot,
          msg,
          exactKey,
          highLoad,
          responseCache,
          pointerCache,
          pointerUpdates,
        );

        if (responded) {
          processed++;
        }
      } catch (err) {
        console.error('Msg error:', err);
      }
    }

    if (chatRecords.length > 0) {
      await upsertChats(supabase, chatRecords);
    }

    if (pointerUpdates.size > 0) {
      await persistPointerUpdates(supabase, bot.id, pointerUpdates);
    }

    const newOffset = Math.max(...updates.map((update: any) => update.update_id)) + 1;
    stateMap.set(bot.id, newOffset);
    await persistBotOffset(supabase, bot.id, newOffset);

  } catch (err) {
    console.error(`Poll error @${bot.bot_username}:`, err);
  }

  return { processed, hadUpdates: processed > 0 || didBroadcast };
}

// Broadcast a channel post immediately to ALL chats (private + groups) where this bot is active.
// Uses copyMessage so the message appears as if sent by the bot itself (no "Forwarded from" tag,
// works for text, photo, video, document, sticker, voice, etc.).
async function broadcastChannelPost(supabase: any, bot: BotRow, post: any): Promise<number> {
  const sourceChatId = Number(post.chat?.id);
  const sourceMessageId = Number(post.message_id);
  if (!Number.isFinite(sourceChatId) || !Number.isFinite(sourceMessageId)) return 0;

  const claim = await claimBroadcastOnce(supabase, bot, sourceChatId, sourceMessageId);
  if (!claim) return 0;

  let totalSent = 0;
  let lastChatId = -Infinity;

  // Page through ALL recipient chats for this bot (private + groups + supergroups)
  while (true) {
    let query = supabase
      .from('bot_chats')
      .select('chat_id')
      .eq('bot_id', bot.id)
      .eq('is_active', true)
      .order('chat_id', { ascending: true })
      .limit(BROADCAST_PAGE_SIZE);

    if (Number.isFinite(lastChatId)) {
      query = query.gt('chat_id', lastChatId);
    }

    const { data: recipients, error } = await query;
    if (error) {
      console.error(`@${bot.bot_username}: broadcast fetch failed`, error);
      break;
    }
    if (!recipients?.length) break;

    for (let i = 0; i < recipients.length; i += BROADCAST_CHUNK_SIZE) {
      const chunk = recipients.slice(i, i + BROADCAST_CHUNK_SIZE);
      const claimedRecipients = await claimBroadcastRecipients(supabase, bot, sourceChatId, sourceMessageId, chunk);
      if (claimedRecipients.length === 0) continue;

      const results = await Promise.allSettled(
        claimedRecipients.map((r: RecipientClaim) =>
          callTelegramWithRetry(bot.api_key, 'copyMessage', {
            chat_id: r.target_chat_id,
            from_chat_id: sourceChatId,
            message_id: sourceMessageId,
          }, TELEGRAM_RETRY_ATTEMPTS)
        )
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled' && result.value?.ok) {
          totalSent++;
          await markRecipientBroadcastDone(supabase, claimedRecipients[j].id, 'completed');
        } else {
          const desc = result.status === 'fulfilled'
            ? String(result.value?.description || '')
            : String(result.reason || '');
          await markRecipientBroadcastDone(supabase, claimedRecipients[j].id, 'failed', desc.slice(0, 500));
          // Mark chats that have kicked/blocked the bot as inactive so we stop hitting them
          if (/bot was kicked|bot was blocked|chat not found|user is deactivated|forbidden/i.test(desc)) {
            const badChatId = Number(claimedRecipients[j].target_chat_id);
            await supabase
              .from('bot_chats')
              .update({ is_active: false, updated_at: new Date().toISOString() })
              .eq('bot_id', bot.id)
              .eq('chat_id', badChatId);
          }
        }
      }

      // small breather between chunks to respect Telegram global limits (~30 msg/sec)
      await delay(800);
    }

    lastChatId = Number(recipients[recipients.length - 1].chat_id);
    if (recipients.length < BROADCAST_PAGE_SIZE) break;
  }

  await supabase
    .from('bot_broadcast_deliveries')
    .update({
      status: 'completed',
      delivered_count: totalSent,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', claim.id);

  console.log(`@${bot.bot_username}: broadcast post ${sourceMessageId} → ${totalSent} chats`);
  return totalSent;
}

async function claimBroadcastOnce(
  supabase: any,
  bot: BotRow,
  sourceChatId: number,
  sourceMessageId: number,
): Promise<BroadcastClaim | null> {
  const { data, error } = await supabase
    .from('bot_broadcast_deliveries')
    .insert({
      bot_id: bot.id,
      source_chat_id: sourceChatId,
      source_message_id: sourceMessageId,
      status: 'processing',
    })
    .select('id')
    .single();

  if (!error && data?.id) return data;

  if (error?.code === '23505' || /duplicate key|bot_broadcast_deliveries/i.test(String(error?.message || ''))) {
    console.log(`@${bot.bot_username}: skipped duplicate broadcast post ${sourceMessageId}`);
    return null;
  }

  console.error(`@${bot.bot_username}: broadcast claim failed`, error);
  return null;
}

async function claimBroadcastRecipients(
  supabase: any,
  bot: BotRow,
  sourceChatId: number,
  sourceMessageId: number,
  recipients: any[],
): Promise<RecipientClaim[]> {
  const rows = recipients.map((recipient: any) => ({
    source_chat_id: sourceChatId,
    source_message_id: sourceMessageId,
    target_chat_id: Number(recipient.chat_id),
    bot_id: bot.id,
    status: 'processing',
  })).filter((row) => Number.isFinite(row.target_chat_id));

  if (rows.length === 0) return [];

  const { data, error } = await supabase
    .from('bot_broadcast_recipient_deliveries')
    .upsert(rows, {
      onConflict: 'source_chat_id,source_message_id,target_chat_id',
      ignoreDuplicates: true,
    })
    .select('id, target_chat_id');

  if (!error && Array.isArray(data)) return data;

  console.error(`@${bot.bot_username}: recipient claim failed`, error);
  return [];
}

async function markRecipientBroadcastDone(
  supabase: any,
  claimId: string,
  status: 'completed' | 'failed',
  errorText?: string,
) {
  await supabase
    .from('bot_broadcast_recipient_deliveries')
    .update({
      status,
      error_text: errorText || null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', claimId);
}

async function handleStart(bot: BotRow, msg: any) {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  await upsertChats(supabase, [{
    bot_id: bot.id,
    chat_id: msg.chat.id,
    chat_title: msg.chat.first_name || msg.chat.username || null,
    chat_type: 'private',
    chat_username: msg.chat.username || null,
    is_active: true,
    updated_at: new Date().toISOString(),
  }]);

  const greeting = '👋 မင်္ဂလာပါ! Group ထဲထည့်ပေးပါ။\n\nGroup ထဲမှာ User တွေ Reply နဲ့ စကားပြန်ပြောပေးမယ်';
  const keyboard: any[][] = [];

  // Fetch bot_links from database
  const { data: botLinks } = await supabase
    .from('bot_links')
    .select('link_title, link_url')
    .eq('bot_id', bot.id)
    .order('created_at', { ascending: true });

  if (botLinks && botLinks.length > 0) {
    for (const link of botLinks) {
      keyboard.push([{ text: link.link_title, url: link.link_url }]);
    }
  } else if (bot.start_link) {
    keyboard.push([{ text: '📢 Join ပေးပါရန်', url: bot.start_link }]);
  }
  keyboard.push([{ text: '➕ Group ထဲ ထည့်ရန်', url: `https://t.me/${bot.bot_username}?startgroup=true` }]);
  await callTelegram(bot.api_key, 'sendMessage', {
    chat_id: msg.chat.id,
    text: greeting,
    reply_markup: { inline_keyboard: keyboard },
  });
}

function collectChatRecords(botId: string, messages: any[], chatBotMap: Map<number, string[]>) {
  const records = new Map<string, ChatRecord>();

  for (const msg of messages) {
    const chat = msg?.chat;
    if (!chat) continue;

    const chatId = Number(chat.id);
    if (Number.isFinite(chatId)) {
      const existing = chatBotMap.get(chatId) ?? [];
      if (!existing.includes(botId)) {
        existing.push(botId);
        existing.sort();
        chatBotMap.set(chatId, existing);
      }
    }

    const key = `${botId}:${chat.id}`;
    records.set(key, {
      bot_id: botId,
      chat_id: chat.id,
      chat_title: chat.title || chat.first_name || null,
      chat_type: chat.type,
      chat_username: chat.username || null,
      is_active: true,
      updated_at: new Date().toISOString(),
    });
  }

  return Array.from(records.values());
}

async function upsertChats(supabase: any, rows: ChatRecord[]) {
  const { error } = await supabase.from('bot_chats').upsert(rows, { onConflict: 'bot_id,chat_id' });
  if (error) {
    console.error('bot_chats upsert failed:', error);
  }
}

async function persistBotOffset(supabase: any, botId: string, updateOffset: number) {
  const { error } = await supabase.from('bot2_states').upsert(
    { bot_id: botId, update_offset: updateOffset, updated_at: new Date().toISOString() },
    { onConflict: 'bot_id' }
  );
  if (error) {
    console.error('Failed to persist bot offset:', error);
  }
}

function isMessageFresh(msg: any, nowSeconds = Math.floor(Date.now() / 1000)) {
  const messageDate = Number(msg?.date || 0);
  if (!Number.isFinite(messageDate) || messageDate <= 0) return true;
  return nowSeconds - messageDate <= STALE_REPLY_MAX_AGE_SECONDS;
}

async function hydrateChatBotsForChat(
  supabase: any,
  chatBotMap: Map<number, string[]>,
  chatIdRaw: number,
  currentBotId: string,
) {
  const chatId = Number(chatIdRaw);
  if (!Number.isFinite(chatId)) return;

  if (!chatBotMap.has(chatId)) {
    const { data: rows } = await supabase
      .from('bot_chats')
      .select('bot_id')
      .eq('chat_id', chatId)
      .eq('is_active', true);

    const botIds = Array.from(new Set((rows || []).map((row: any) => row.bot_id).concat(currentBotId))).sort();
    chatBotMap.set(chatId, botIds as string[]);
    return;
  }

  const existing = chatBotMap.get(chatId) ?? [];
  if (!existing.includes(currentBotId)) {
    existing.push(currentBotId);
    existing.sort();
    chatBotMap.set(chatId, existing);
  }
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

function collectLearnedPairs(messages: any[]): LearnedPair[] {
  const uniquePairs = new Map<string, LearnedPair>();

  for (const msg of messages) {
    if (msg?.from?.is_bot) continue;
    if (!msg?.reply_to_message) continue;

    const triggerContent = parseContent(msg.reply_to_message);
    const responseContent = parseResponseContent(msg);
    if (!triggerContent || !responseContent) continue;

    const triggerKey = encodeContent(triggerContent);
    const responseKey = encodeContent(responseContent);
    uniquePairs.set(`${triggerKey}=>${responseKey}`, { triggerKey, responseKey });
  }

  return Array.from(uniquePairs.values());
}

async function learnPairsBatch(
  supabase: any,
  botId: string,
  pairs: LearnedPair[],
  botUsername: string | null,
  responseCache: Map<string, string[]>,
) {
  if (pairs.length === 0) return;

  const inserts = pairs
    .map((pair) => ({
      bot_id: botId,
      trigger_text: pair.triggerKey,
      response_text: pair.responseKey,
    }));

  if (inserts.length === 0) return;

  const { error } = await supabase
    .from('trigger_responses')
    .upsert(inserts, { onConflict: 'bot_id,trigger_text,response_text', ignoreDuplicates: true });
  if (error) {
    console.error('Failed to insert learned pairs:', error);
    return;
  }

  for (const pair of pairs) {
    const cachedResponses = responseCache.get(responseCacheKey(botId, pair.triggerKey));
    if (cachedResponses && !cachedResponses.includes(pair.responseKey)) {
      cachedResponses.push(pair.responseKey);
    }
    console.log(`@${botUsername} learned: "${pair.triggerKey}" -> "${pair.responseKey}"`);
  }
}

async function warmCaches(
  supabase: any,
  botId: string,
  exactKeys: string[],
  responseCache: Map<string, string[]>,
  pointerCache: Map<string, number>,
) {
  const missingResponseKeys = exactKeys.filter((key) => !responseCache.has(responseCacheKey(botId, key)));
  if (missingResponseKeys.length > 0) {
    for (const key of missingResponseKeys) {
      responseCache.set(responseCacheKey(botId, key), []);
    }

    for (const batch of chunkArray(missingResponseKeys, CACHE_WARM_BATCH_SIZE)) {
      const { data: responseRows, error } = await supabase
        .from('trigger_responses')
        .select('trigger_text, response_text, created_at')
        .eq('bot_id', botId)
        .in('trigger_text', batch)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Failed to warm response cache:', error);
        break;
      }

      for (const row of responseRows || []) {
        const cacheKey = responseCacheKey(botId, row.trigger_text);
        const existing = responseCache.get(cacheKey) ?? [];
        existing.push(row.response_text);
        responseCache.set(cacheKey, existing);
      }
    }
  }

  const missingPointerKeys = exactKeys.filter((key) => !pointerCache.has(pointerCacheKey(botId, key)));
  if (missingPointerKeys.length === 0) return;

  for (const key of missingPointerKeys) {
    pointerCache.set(pointerCacheKey(botId, key), 0);
  }

  for (const batch of chunkArray(missingPointerKeys, CACHE_WARM_BATCH_SIZE)) {
    const { data: pointerRows, error } = await supabase
      .from('trigger_pointers')
      .select('trigger_text, pointer')
      .eq('bot_id', botId)
      .in('trigger_text', batch);

    if (error) {
      console.error('Failed to warm pointer cache:', error);
      return;
    }

    for (const row of pointerRows || []) {
      pointerCache.set(pointerCacheKey(botId, row.trigger_text), row.pointer || 0);
    }
  }
}

async function tryRespond(
  supabase: any,
  bot: BotRow,
  msg: any,
  exactKey: string,
  highLoad: boolean,
  responseCache: Map<string, string[]>,
  pointerCache: Map<string, number>,
  pointerUpdates: Map<string, number>,
) {
  const responses = responseCache.get(responseCacheKey(bot.id, exactKey)) ?? [];
  if (responses.length === 0) return false;

  const cacheKey = pointerCacheKey(bot.id, exactKey);
  let ptr = pointerUpdates.get(exactKey) ?? pointerCache.get(cacheKey) ?? 0;
  if (ptr >= responses.length) ptr = 0;

  const selected = decodeContent(responses[ptr]);
  const action = selected.kind === 'sticker' ? 'choose_sticker' : 'typing';
  callTelegram(bot.api_key, 'sendChatAction', { chat_id: msg.chat.id, action }).catch(() => {});
  await delay(highLoad ? 20 + Math.random() * 40 : 45 + Math.random() * 90);

  let sendResult: any;

  if (selected.kind === 'sticker') {
    sendResult = await callTelegramWithRetry(bot.api_key, 'sendSticker', {
      chat_id: msg.chat.id,
      sticker: selected.value,
      reply_to_message_id: msg.message_id,
      allow_sending_without_reply: true,
    });
  } else if (selected.kind === 'voice') {
    sendResult = await callTelegramWithRetry(bot.api_key, 'sendVoice', {
      chat_id: msg.chat.id,
      voice: selected.value,
      reply_to_message_id: msg.message_id,
      allow_sending_without_reply: true,
    });
  } else {
    const payload: Record<string, unknown> = {
      chat_id: msg.chat.id,
      text: selected.value,
      reply_to_message_id: msg.message_id,
      allow_sending_without_reply: true,
    };
    if (selected.entities && selected.entities.length > 0) {
      payload.entities = selected.entities;
    }
    sendResult = await callTelegramWithRetry(bot.api_key, 'sendMessage', payload);
  }

  if (!sendResult?.ok) {
    console.error(`@${bot.bot_username}: reply failed`, sendResult);
    return false;
  }

  const nextPtr = (ptr + 1) % responses.length;
  pointerCache.set(cacheKey, nextPtr);
  pointerUpdates.set(exactKey, nextPtr);
  console.log(`@${bot.bot_username} replied for "${exactKey}"`);
  return true;
}

async function persistPointerUpdates(supabase: any, botId: string, pointerUpdates: Map<string, number>) {
  const rows = Array.from(pointerUpdates.entries()).map(([trigger_text, pointer]) => ({
    bot_id: botId,
    trigger_text,
    pointer,
  }));

  const { error } = await supabase.from('trigger_pointers').upsert(rows, { onConflict: 'bot_id,trigger_text' });
  if (error) {
    console.error('Failed to persist trigger pointers:', error);
  }
}

function maybeReactToMessage(apiKey: string, chatId: number, messageId: number) {
  if (Math.random() > REACTION_SAMPLE_RATE) return;
  const emoji = REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
  callTelegram(apiKey, 'setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji }],
  }).catch(() => {});
}

async function callTelegramWithRetry(
  apiKey: string,
  method: string,
  payload: Record<string, unknown>,
  attempts = TELEGRAM_RETRY_ATTEMPTS,
) {
  let lastResponse: any = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    lastResponse = await callTelegram(apiKey, method, payload);
    if (lastResponse?.ok) return lastResponse;

    if (!shouldRetryTelegramResponse(lastResponse) || attempt === attempts - 1) {
      return lastResponse;
    }

    const retryAfterMs = Number(lastResponse?.parameters?.retry_after || 0) * 1000;
    await delay(Math.max(retryAfterMs, 800 * (attempt + 1)));
  }

  return lastResponse;
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

function shouldRetryTelegramResponse(result: any) {
  if (!result || result.ok) return false;

  const errorCode = Number(result.error_code || 0);
  const description = String(result.description || '').toLowerCase();

  return errorCode === 429
    || errorCode >= 500
    || description.includes('timed out')
    || description.includes('timeout')
    || description.includes('too many requests')
    || description.includes('temporarily unavailable')
    || description.includes('internal server error');
}

function isStartCommand(text: unknown) {
  return typeof text === 'string' && /^\/start(?:@\w+)?(?:\s|$)/.test(text.trim());
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

function encodeContent(content: ParsedContent): string {
  if (content.kind === 'text_rich' && content.entities && content.entities.length > 0) {
    return `text_rich:${JSON.stringify({ text: content.value, entities: content.entities })}`;
  }
  return `${content.kind}:${content.value}`;
}

function decodeContent(stored: string): ParsedContent {
  if (stored.startsWith('text_rich:')) {
    try {
      const data = JSON.parse(stored.slice(9));
      return { kind: 'text', value: data.text, entities: data.entities };
    } catch {
      return { kind: 'text', value: stored.slice(9) };
    }
  }
  if (stored.startsWith('text:')) return { kind: 'text', value: stored.slice(5) };
  if (stored.startsWith('sticker:')) return { kind: 'sticker', value: stored.slice(8) };
  if (stored.startsWith('voice:')) return { kind: 'voice', value: stored.slice(6) };
  return { kind: 'text', value: stored };
}

// Parse response content preserving original text case and custom emoji entities
function parseResponseContent(msg: any): ParsedContent | null {
  if (typeof msg?.text === 'string' && msg.text.trim().length > 0) {
    const text = msg.text.trim();
    // Check for custom_emoji entities (premium emoji)
    const customEmojiEntities = (msg.entities || []).filter((e: any) => e.type === 'custom_emoji');
    if (customEmojiEntities.length > 0) {
      return { kind: 'text_rich', value: text, entities: customEmojiEntities };
    }
    return { kind: 'text', value: text.replace(/\s+/g, ' ').toLocaleLowerCase() };
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

function pointerCacheKey(botId: string, triggerKey: string) {
  return `${botId}:${triggerKey}`;
}

function responseCacheKey(botId: string, triggerKey: string) {
  return `${botId}:${triggerKey}`;
}

async function readShardConfig(req: Request) {
  if (req.method !== 'POST') {
    return { shard: 0, shards: 1 };
  }

  try {
    const body = await req.json();
    const shards = Math.max(1, Math.min(32, Number(body?.shards) || 1));
    const shard = Math.max(0, Math.min(shards - 1, Number(body?.shard) || 0));
    return { shard, shards };
  } catch {
    return { shard: 0, shards: 1 };
  }
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
