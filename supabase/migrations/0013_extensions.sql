-- Orbit AI 0013: installed plugins and skills (Plugins page), so a student's setup follows them to any device.
-- kind 'plugin': ext_id = a plugin id (lib/plugins/catalog.ts). Sign-ins/tokens are NOT stored here; they stay in the browser.
-- kind 'skill':  ext_id = a built-in skill id, or 'p-<uuid>' for the student's own skill (data = {name, description, instructions}).
-- Apply after 0012: Supabase → SQL Editor → paste this whole file → Run. Safe to run twice.
create table if not exists public.user_extensions (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('plugin', 'skill')),
  ext_id text not null check (char_length(ext_id) between 1 and 64),
  enabled boolean not null default true,
  data jsonb not null default '{}'::jsonb check (octet_length(data::text) <= 8000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, ext_id)
);

alter table public.user_extensions enable row level security;
drop policy if exists "own extensions" on public.user_extensions;
create policy "own extensions" on public.user_extensions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
