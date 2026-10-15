-- Optional semantic memory. Run before enabling SMART_MEMORY_ENABLED. Exact search first, no vector DB service.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create table public.context_embeddings (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
 conversation_id uuid references public.conversations(id) on delete cascade,
 message_id uuid references public.messages(id) on delete cascade,
 memory_id uuid references public.memories(id) on delete cascade,
 source_kind text not null check(source_kind in ('message','summary','memory')),
 source_id uuid not null,
 content_hash text not null,
 model text not null default 'text-embedding-3-small',
 embedding extensions.vector(1536) not null,
 created_at timestamptz not null default now(),
 unique(user_id,source_kind,source_id),
 check ((source_kind='message' and message_id is not null and message_id=source_id and conversation_id is not null and memory_id is null)
   or (source_kind='summary' and conversation_id=source_id and message_id is null and memory_id is null)
   or (source_kind='memory' and memory_id is not null and memory_id=source_id and message_id is null and conversation_id is null))
);
alter table public.context_embeddings enable row level security;
create policy "own enabled context embeddings" on public.context_embeddings for all to authenticated
 using (user_id=auth.uid() and exists(select 1 from public.profiles where user_id=auth.uid() and memory_enabled))
 with check(user_id=auth.uid() and exists(select 1 from public.profiles where user_id=auth.uid() and memory_enabled)
 and (case source_kind
   when 'message' then exists(select 1 from public.messages m where m.id=message_id and m.user_id=auth.uid() and m.conversation_id=context_embeddings.conversation_id)
   when 'summary' then exists(select 1 from public.conversations c where c.id=conversation_id and c.user_id=auth.uid())
   when 'memory' then exists(select 1 from public.memories m where m.id=memory_id and m.user_id=auth.uid())
   else false end));

-- Invoker security: both embedding and original source RLS apply. Nothing crosses users; history stays in this chat.
-- Return source text at read time, so deletion/editing takes effect immediately, with a hash check against stale vectors.
create or replace function public.retrieve_context(p_embedding extensions.vector(1536),p_conversation_id uuid,p_limit integer default 4)
returns table(source_kind text,source_id uuid,content text,similarity double precision)
language sql stable security invoker set search_path=public,extensions as $$
 with sources as (
 select e.*, left(case e.source_kind when 'message' then m.content when 'summary' then c.summary else mem.content end,1800) as body
 from public.context_embeddings e
 left join public.messages m on m.id=e.message_id and m.conversation_id=p_conversation_id and m.status<>'error'
 left join public.conversations c on c.id=e.conversation_id and c.id=p_conversation_id
 left join public.memories mem on mem.id=e.memory_id
 where e.user_id=auth.uid() and (e.conversation_id=p_conversation_id or e.source_kind='memory')
 and e.model='text-embedding-3-small'
 )
 select s.source_kind,s.source_id,s.body,1-(s.embedding <=> p_embedding)
 from sources s where s.body is not null and s.content_hash=encode(digest(s.body,'sha256'),'hex')
 order by s.embedding <=> p_embedding limit least(greatest(p_limit,0),8);
$$;
revoke all on function public.retrieve_context(extensions.vector,uuid,integer) from public,anon;
grant execute on function public.retrieve_context(extensions.vector,uuid,integer) to authenticated;

-- Memory off purges derived vectors; full chat history and ordinary summaries remain student-visible.
create or replace function public.purge_disabled_context() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if not new.memory_enabled then delete from public.context_embeddings where user_id=new.user_id; end if;
 return new;
end $$;
revoke all on function public.purge_disabled_context() from public,anon,authenticated;
create trigger orbit_memory_disabled after update of memory_enabled on public.profiles
 for each row execute function public.purge_disabled_context();

-- Linked saved memories are derived from this chat; deleting it also deletes those memory/vector records.
alter table public.memories drop constraint if exists memories_conversation_id_fkey;
alter table public.memories add constraint memories_conversation_id_fkey foreign key(conversation_id) references public.conversations(id) on delete cascade;
