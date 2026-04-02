begin;

with ranked as (
  select ctid, row_number() over (partition by bot_id, chat_id order by updated_at desc, created_at desc, ctid desc) as rn
  from public.bot_chats
)
delete from public.bot_chats
where ctid in (select ctid from ranked where rn > 1);

with ranked as (
  select ctid, row_number() over (partition by bot_id, trigger_text order by pointer desc, ctid desc) as rn
  from public.trigger_pointers
)
delete from public.trigger_pointers
where ctid in (select ctid from ranked where rn > 1);

create index if not exists idx_bot_chats_bot_private_chat
  on public.bot_chats (bot_id, chat_type, chat_id);

create table if not exists public.channel_forward_jobs (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references public.bots(id) on delete cascade,
  source_chat_id bigint not null,
  source_message_id bigint not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  last_chat_id bigint not null default 0,
  total_recipients integer not null default 0,
  processed_count integer not null default 0,
  success_count integer not null default 0,
  failed_count integer not null default 0,
  last_error text,
  completed_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (bot_id, source_chat_id, source_message_id)
);

alter table public.channel_forward_jobs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'channel_forward_jobs'
      and policyname = 'Service role full access on channel_forward_jobs'
  ) then
    create policy "Service role full access on channel_forward_jobs"
    on public.channel_forward_jobs
    for all
    to service_role
    using (true)
    with check (true);
  end if;
end $$;

create index if not exists idx_channel_forward_jobs_bot_status_created
  on public.channel_forward_jobs (bot_id, status, created_at);

create index if not exists idx_channel_forward_jobs_status_updated
  on public.channel_forward_jobs (status, updated_at);

commit;