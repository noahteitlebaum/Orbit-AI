-- Polar AI 0003: each app (ChatGPT, Claude, Gemini, Grok) has its own courses; courses and chats never cross over.
-- Apply after 0002: Supabase → SQL Editor → paste this whole file → Run. Safe to run twice.

-- 1. Give every shared course (provider = null) to the app with the most chats in it (ChatGPT if it has none).
update public.projects p
   set provider = coalesce((
     select c.provider from public.conversations c
      where c.project_id = p.id
      group by c.provider
      order by count(*) desc, max(c.updated_at) desc
      limit 1), 'openai')
 where p.provider is null;

-- 2. Chats from other apps that were inside that course move out of it (the chats themselves are kept).
update public.conversations c
   set project_id = null
  from public.projects p
 where c.project_id = p.id and p.provider <> c.provider;

-- 3. Every course belongs to exactly one app from now on.
alter table public.projects alter column provider set not null;

-- 4. A chat can only be put in a course from its own app.
drop policy if exists "own conversations" on public.conversations;
create policy "own conversations" on public.conversations for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (project_id is null or exists (
      select 1 from public.projects p
      where p.id = project_id and p.user_id = auth.uid() and p.provider = conversations.provider))
  );
