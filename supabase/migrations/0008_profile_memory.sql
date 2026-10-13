-- Polar AI 0008: personal preferences (Settings → Profile) and saved memories (Settings → Memory).
-- One profile row per student, shared by all four AI apps. Memories are short facts the student (or the AI, when the
-- student turned memory on) saved; the student can see, add and delete every one of them.
-- Apply after 0007: Supabase → SQL Editor → paste this whole file → Run. Safe to run twice.

create table if not exists public.profiles (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 60),
  program text not null default '' check (char_length(program) <= 120),       -- e.g. "BSc Biology"
  level text not null default '' check (char_length(level) <= 40),            -- e.g. "2nd year"
  style text not null default '' check (char_length(style) <= 40),            -- explanation style key (lib/profile/personal.ts)
  length text not null default '' check (char_length(length) <= 20),          -- answer length key
  about text not null default '' check (char_length(about) <= 1500),          -- "What should the AI know about you?"
  instructions text not null default '' check (char_length(instructions) <= 1500), -- "How should it respond?"
  memory_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 300),
  source text not null default 'student' check (source in ('student', 'ai')),
  conversation_id uuid references public.conversations(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists memories_user_idx on public.memories (user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.memories enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own memories" on public.memories;
create policy "own memories" on public.memories for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
