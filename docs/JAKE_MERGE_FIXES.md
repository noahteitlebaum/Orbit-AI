# Jake: compatible context and consent fixes

## Branch reconciliation

The former Jake patch (5cca1ed) was based on an old scaffold and overlapped newer context/billing work already on main.
Merge commit 564e778 preserves both branch histories and resolves that overlap to exactly main commit e64b4b0.
Both trees were verified as 31e201f91801682ce5c2bfd6dd387160de6dcdb9 before adding fixes. No force push is required.
The obsolete 0009_smart_context.sql is removed; the current 0009_usage_analytics.sql and v2 budget RPCs are retained.

## Changes relative to main

- Gemini video requests are counted with the same normalized request body used for generation (system, tools, media
  resolution and history). The complete input must fit the existing 24,000-token ceiling; a failed or malformed count
  blocks video generation. Reservations use the full count without assuming a video duration. Other providers and
  ordinary Gemini text requests do not incur this preflight. Counter responses are not analytics events or fake
  zero-dollar ledger rows. Actual generation usage still settles the reserved budget.
- AI memory saves re-read the current opt-in. Migration 0013 serializes AI inserts/updates against preference changes
  by share-locking the profile row, rejects foreign-conversation references, and skips disabled/missing profiles.
  Manual notes remain supported. Already saved memories are not erased by disabling memory.
- Ordinary material selection is limited to 2,000 estimated tokens; explicit summarize/review/compare/whole-file tasks
  can use 12,000. Merely having files does not automatically select the larger context target. Clear generic file
  references use the latest attachment batch. New uploads, named pages and genuine follow-ups remain supported.
  Unrelated old text and scanned PDFs are not resent as filler. Material clipping is disclosed to the model.
- Saved facts with zero keyword matches are omitted. Durable response preferences continue to come from the profile.
- Image-slot estimates count actual image files, rather than treating documents as images, and include every candidate
  attachment that the final kept-history loader could select, preserving the shared MAX_IMAGES limit.

## Deployment

For a database already running current main's migrations 0001–0012, apply **0013_ai_memory_consent.sql before deploying
this branch**. The application-level refresh closes the common in-flight case; the migration is necessary for atomic
protection against a preference update racing with an insert. Stage all changes with synthetic accounts first.

Do not apply the removed 0009_smart_context.sql from the superseded patch. If it was already applied, removing a file
from Git does not undo its database changes. Inspect/reconcile that staging schema against main's 0001–0012 before
applying 0013 or deploying; do not reset student balances or replace production functions blindly. The migration test
suite validates a fresh main schema plus 0013, not arbitrary historical manual migration orders.

Video preflight follows https://ai.google.dev/api/tokens and uses the documented generateContentRequest envelope.
Google's token-counting billing FAQ: https://ai.google.dev/gemini-api/docs/billing . Unsupported video/count combinations
fail closed and show a transcript-excerpt alternative. Validate a small synthetic video in staging before launch.

No live model calls, database deployment, or merge into main is part of this change. Local checks use mocked providers
and a local PostgreSQL-compatible engine with synthetic records. Refresh main and rerun the merge check before publishing
if main changes; a clean merge only proves compatibility with the checked main commit.

## Verified locally

- Lint and Next-generated TypeScript checks passed.
- Full suite: 305 tests passed across 42 files, including local PostgreSQL migration/RLS checks.
- Second-model review completed with no remaining blocking findings.
- Merge compatibility checked against main e64b4b0; that commit is an ancestor of the revised Jake branch.
