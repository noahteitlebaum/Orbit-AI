-- Polar AI 0006: quiz progress per chat, e.g. {"asked":5,"correct":3,"concepts":{"Variance":{"right":0,"wrong":2}}}.
-- Updated by the server from the model's per-answer results (the model never sets the score itself).
-- Apply after 0005: Supabase → SQL Editor → paste this whole file → Run. Safe to run twice.
alter table public.conversations add column if not exists quiz_state jsonb;
