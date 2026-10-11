-- Polar AI 0004: folder access (desktop helper). Stores the file actions taken while writing a reply,
-- e.g. [{"name":"edit_file","label":"Edit notes.md","status":"ok"}], so they show again when the chat is reopened.
-- Apply after 0003: Supabase → SQL Editor → paste this whole file → Run. Safe to run twice.
alter table public.messages add column if not exists tool_log jsonb;
