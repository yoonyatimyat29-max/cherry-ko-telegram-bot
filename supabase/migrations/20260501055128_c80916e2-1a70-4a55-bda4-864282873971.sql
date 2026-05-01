begin;

-- Remove already duplicated learned Q&A pairs before enforcing uniqueness.
with ranked as (
  select
    ctid,
    row_number() over (
      partition by bot_id, trigger_text, response_text
      order by created_at asc, id asc
    ) as rn
  from public.trigger_responses
)
delete from public.trigger_responses
where ctid in (select ctid from ranked where rn > 1);

-- Prevent the exact same question+answer pair from being learned more than once per bot,
-- even if two polling invocations race each other.
create unique index if not exists ux_trigger_responses_bot_trigger_response
  on public.trigger_responses (bot_id, trigger_text, response_text);

-- Speed up exact-match response lookups ordered by oldest learned response first.
create index if not exists idx_trigger_responses_bot_trigger_created
  on public.trigger_responses (bot_id, trigger_text, created_at);

-- Speed up group-to-bot hydration when a message arrives in a busy group.
create index if not exists idx_bot_chats_chat_active_bot
  on public.bot_chats (chat_id, is_active, bot_id);

-- Speed up fetching one bot's polling state.
create index if not exists idx_bot2_states_bot_id_offset
  on public.bot2_states (bot_id, update_offset);

commit;