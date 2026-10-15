-- Polar AI 0012: chats imported from ChatGPT / Claude exports (Settings → Import).
-- import_key = "<source>:<the export's conversation id>", unique per student, so importing the same export twice
-- doesn't create duplicates. Imported messages are ordinary rows (seq keeps the original order).
-- Apply after 0011: Supabase → SQL Editor → paste this whole file → Run. Safe to run twice.
alter table public.conversations add column if not exists imported_from text check (imported_from in ('chatgpt', 'claude'));
alter table public.conversations add column if not exists import_key text check (char_length(import_key) <= 200);
create unique index if not exists conversations_import_key_idx on public.conversations (user_id, import_key);
