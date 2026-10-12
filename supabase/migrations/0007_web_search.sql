-- Polar AI 0007: web search results saved with the question they answered:
--   {"query": "...", "at": "2026-10-12T…", "results": [{"title","url","content","published"}]}
-- so retries, follow-ups and other models reuse the same results (and the student isn't charged twice).
-- Apply after 0006: Supabase → SQL Editor → paste this whole file → Run. Safe to run twice.
alter table public.messages add column if not exists web_results jsonb;
