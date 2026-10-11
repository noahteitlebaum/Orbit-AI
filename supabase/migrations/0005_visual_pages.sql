-- Polar AI 0005: don't silently miss visual material in uploads.
--   visual_pages: PDF pages that are scanned or carry a diagram/picture; sent to the model as page images.
--   image_count:  pictures inside a Word file (their text can't be read; the student is told).
-- Apply after 0004: Supabase → SQL Editor → paste this whole file → Run. Safe to run twice.
alter table public.files add column if not exists visual_pages integer[] not null default '{}';
alter table public.files add column if not exists image_count integer not null default 0;
