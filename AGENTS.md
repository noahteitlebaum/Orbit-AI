# AGENTS.md — Orbit AI

Read this first in every AI session. Also read `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, and `docs/TASKS.md`. If anything here conflicts with a direct instruction from Noah, follow Noah and update this file.

## What this is
A mobile-friendly web app that gives verified @uwo.ca students one place to use OpenAI, Anthropic (Claude), Google (Gemini) and xAI (Grok). Each AI app (ChatGPT, Claude, Gemini, Grok) has its own chat list; inside a chat, students can switch between that app's models and keep the context. Chats and courses never carry over between apps: each app has its own chats and its own courses (Noah, Oct 2026). **Launch: Monday Oct 19 2026.**

## Stack (provisional; change it here if it changes)
- Next.js (App Router) + TypeScript + Tailwind
- Supabase: Postgres, Auth (email OTP), Row Level Security
- Vercel hosting (preview deploy for each branch)
- Provider SDKs called **only from server code** (route handlers / server actions)
- Tests: Vitest (unit/integration), Playwright (core journey on phone and desktop)

## Commands
```
npm run dev        # local dev
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm test           # vitest (mock providers, no live API calls)
npm run test:e2e   # playwright
npm run test:live  # small opt-in live checks against all 4 providers (costs money)
```
(Add a script to package.json if it doesn't exist yet.)

## Hard rules (never violate)
1. **API keys stay on the server.** Never send them to the client, logs, or prompts. Use env vars only.
2. **Access:** only users who have verified an email at the exact domain `uwo.ca` may get credits or call a model. Enforce this on the server, not just in the UI. Reject subdomains and lookalike domains (`uwo.ca.evil.com`, `xuwo.ca`, unicode lookalikes).
2a. **Waitlist:** while `WAITLIST_MODE` is on, only emails in `EARLY_ACCESS_EMAILS` reach the app; everyone else sees `/waitlist`. Enforce with `getUserAccess()` on every page and API route that uses models.
3. **Ownership:** a user can only read or write their own conversations. Enforce with RLS **and** server checks.
4. **Budget:** every model call does an atomic reserve → call → reconcile against a dollar budget (see ARCHITECTURE.md). Don't make a provider call without a reservation.
5. **No silent model substitution.** If a provider fails, show an error and let the student choose another model.
6. **No silent history dropping.** Use the disclosed context policy for long chats.
7. **Privacy:** never log message content. Log IDs, model, token counts, cost, error codes.
8. **Config, not code:** model IDs, prices, allowances, rate limits and feature flags live in `src/config/`. Adding a provider should only need a new adapter plus config.
9. **Payments stay disabled** (`PAYMENTS_ENABLED=false`) until Jake gives the final rules.
10. Use synthetic accounts and data only. Never use real student chats in prompts, tests or screenshots.

## Code execution (run_python)
- Runs in the student's browser: Pyodide (WebAssembly) in a module Web Worker (`public/python-worker.mjs`), driven by `lib/code/runner.ts`. No server sandbox, no extra cost.
- Fresh worker per run, terminated after. Network (fetch/XHR/WebSocket/importScripts) is replaced with errors while user code runs; packages load just before.
- Limits: 30 s per run (120 s for first-time setup), browser WebAssembly memory cap (crash = memory limit), outputs ≤ 20 files / 10 MB each / 25 MB total.
- Data files (csv/tsv/xlsx/json/txt from the chat and its course) go to /data via `GET /api/files/:id` (60 s signed link). Outputs in /output become downloads; unsaved matplotlib figures are saved automatically.
- The model is told to run calculations and code instead of guessing. Code and printed output are kept in `messages.tool_log`; output files last only while the page is open.

## Downloads (lib/export/export.ts)
- Each answer: Markdown, plain text, and CSV for every Markdown table. Header "Export": the whole chat as Markdown or text. All built in the browser; no server, no cost.
- Equations stay LaTeX (\( \) → $ $, \[ \] → $$ $$); only real [S#]/[W#] citations are kept, with a sources list (file + page, web title + link); quiz markers removed; Python code/output included.
- CSV: UTF-8 mark for Excel, quoted cells, formula-injection guard. Formatted DOCX/PDF are planned for later.

## Settings: profile and memory (lib/profile/personal.ts, migration 0008)
- Sidebar → Settings: Profile (name, program, year, explanation style, answer length, about me, how to respond), Memory, Courses (shortcut to each course's instructions).
- Profile and memories are per student, shared by all four apps; course instructions stay per app and win on conflicts.
- Memory is off by default. When on, memories go in the prompt and the AI can save one with a hidden `[[remember: …]]` line (removed by the server, saved with source "ai", shown under the answer as "Memory updated"). Students can add, see and delete every memory; max 100, 300 chars each.

## Voice (config/voice.ts)
- Mic button in the message box: record (max 5 min) → `POST /api/transcribe` → OpenAI `gpt-4o-mini-transcribe` (needs OPENAI_API_KEY; works in all four apps) → text lands in the box to check before sending. Course name sent as a vocabulary hint. Nothing stored.
- Billing like web search: reserve $0.006/min, settle $0.003/min (length = max of browser timer and file size), failures not charged. Demo mode: no transcription.
- "Listen" under each answer reads it with the browser's own voices (free; citations/code skipped, simple math spoken).
- Voice conversation (waveform button → `components/voice-mode.tsx`): turn-based, works with all four apps. Mic stays open; `lib/voice/listener.ts` detects when the student stops talking (VAD: level vs background noise, 1 s of quiet), transcribes, sends a normal chat message with `voice: true` (VOICE_PROMPT: short, speakable, no Markdown), and `lib/voice/speaker.ts` speaks finished sentences while the reply streams, then listens again. Tap the circle to finish talking or interrupt. Everything is saved in the chat as text.
- Spoken replies (`/api/speak`, `lib/voice/tts.ts`): ElevenLabs Flash v2.5 if ELEVENLABS_API_KEY is set, else OpenAI gpt-4o-mini-tts (voice "marin"), else browser voices. Billed per character (ledger id `voice-speak`, not counted in the rate limit); a failed request isn't charged and that sentence falls back to the browser voice. The speaker fetches the next sentences' audio while one plays. "Listen" uses the same voice.
- Fillers (`lib/voice/fillers.ts`): when the student stops talking (85% of turns) the AI says a short filler ("Hmm…", "Okay, um…"), and a longer one after 3.2 s with no answer yet ("Uh, give me a second…"); never the same twice in a row. Audio is made once per voice via `/api/speak` and kept in the browser's Cache Storage, so it plays instantly; with cloud voices a filler that isn't ready is skipped (never a different voice). Fillers aren't added to the chat text.
- Speed in voice turns: low reasoning/thinking (OpenAI `reasoning.effort: low`, Gemini `thinkingLevel: low`, retried without if a model rejects it), replies capped at 1,200 tokens, no tools, turn ends after 1 s of quiet, profile loaded in parallel.

## Deferred until after launch (item 12, Noah, Oct 12 2026)
Deep research, connected accounts/integrations (Google Drive, Notion, Canvas/OWL, calendar…) and new image-generation work wait until the core study workflow is reliable with real students: they add cost and complexity without fixing the main reasons students switch. Image generation stays as it is (Gemini, Grok; OpenAI once its price is set) — no new image features. Revisit after launch using usage data; a first candidate is read-only OWL/Brightspace course import, since it feeds the course-files workflow students already use.

## Out of scope for launch (don't build unless the team agrees)
Model comparison, smart model routing, connectors (Drive/GitHub…), coding/computer agents beyond folder access, real-time voice conversation.
**Built (Noah + Jake's backend memo, Oct 2026):** file/image uploads — PDF, Word, PowerPoint (per slide), Excel/CSV (per sheet, as rows), notebooks, code and any text file; phone photos are shrunk/converted in the browser — with page references (PDF pages that are scanned or have diagrams are read visually by ChatGPT/Claude/Gemini, a few per question; pictures in Word files, skipped pages and unmatched course images are named to the model, never silently dropped), courses (one app each: instructions + reusable files), grounded answers with [S#] sources and a "use only my course material" switch, web search (Tavily, "Search the web" toggle; one search per question, charged against the allowance, saved on the question and reused across models; cited as [W#] with links, kept apart from course files [S#] — `lib/search/web.ts`, `config/search.ts`), study modes (explain / quiz me / hints; quiz score and missed concepts are kept by the server from hidden `[[quiz: right|wrong | concept]]` lines, saved per chat and reused across the course — `lib/chat/quiz.ts`), running summaries for long chats, low-balance warning with a cheaper-model offer, image generation (Gemini, Grok; OpenAI once its price is set). **Folder access (Noah, Oct 11 2026):** students can connect one folder on their computer with the browser's folder picker (File System Access API, Chrome/Edge; nothing to install; `lib/folder/browser-fs.ts`); all four AIs can list/read/search and write/edit/move/delete files there; changes need the student's Apply unless they chose "Don't ask for edits" (deletes always ask). Everything that calls a model goes through the same reserve → call → settle budget path, including each round of a file-action reply.

## Where things live (server)
- `supabase/migrations/0001_core.sql` … `0007_web_search.sql` (run in order) — tables, RLS, budget functions (secret key only), `search_chunks` keyword search, private `uploads` + `generated` buckets. Money is in micros (millionths of $).
- `lib/providers/*` — one adapter per provider (fetch + SSE, no SDKs; text + image input). `LIVE_MODELS=on` turns on real calls; otherwise demo replies at no cost.
- `lib/files/extract.ts` — PDF (per page) / DOCX / TXT text extraction and chunking; marks PDF pages that are scanned or carry diagrams (`visual_pages`) and counts Word pictures; scanned PDFs are `needs_ocr` and read only as page images. `lib/files/upload-client.ts` uploads browser → Storage directly (avoids Vercel's 4.5 MB request limit), then `POST /api/files` indexes it.
- `lib/chat/context.ts` — context policy, cost maths, system prompt (modes, course material, course-only). `lib/chat/material.ts` — picks passages ([S#]) from chat attachments + course files (keyword search, files/pages the question names, follow-ups use the previous question; the model always gets the course's file list) and loads images for vision. Chat attachments can be saved to the course (`PATCH /api/files/:id`). `lib/chat/summary.ts` — running summary of messages that no longer fit (cheapest model, budgeted).
- `app/api/chat` (NDJSON stream), `app/api/files`, `app/api/images`, `app/api/conversations`, `app/api/projects` (courses), `app/api/usage`.
- `lib/folder/*` — folder tools (definitions, limits, prompt), tool-run validation (`run.ts`) and the tools themselves, run in the browser on the student's folder (`browser-fs.ts`).
- `config/models.ts` — model ids, prices, context caps, image models, `FOLDER_ACCESS` per app. Prices checked Oct 5 2026; re-check before launch.
- Sources shown to students are only passages the answer actually cited and that were really sent (`citedSources`).

## How to work
- One bounded task at a time, taken from `docs/TASKS.md`, with acceptance criteria.
- Read the relevant code before changing it. Plan multi-file changes first.
- Run `lint`, `typecheck` and `test` before saying a task is done.
- Report: files changed, checks run, unresolved issues.
- Commit each verified increment with a clear message.
- Get a second-model review before merging auth, context transfer, cost accounting or payment changes.

## Definition of done
- Acceptance criteria met and covered by tests (mock providers).
- Works at phone width (375px) and on desktop.
- Server-side enforcement exists for any access, ownership or budget rule touched.
- No secrets or message content in logs.
- Docs updated if a decision changed.

## UI theme
All styling uses the Orbit AI design system ("Orbit Night" dark default, "Orbit Day" light), defined as CSS variables in `app/globals.css` and exposed as Tailwind utilities (`bg-surface-100`, `text-ink-muted`, `border-line`, `bg-brand`, `text-on-brand`, `bg-provider-anthropic`, `shadow-card`…). Never use Tailwind palette colors (zinc, red…) or raw hex in components. Brand pieces (`Wordmark`, `OrbitBackdrop`, `ProviderDot`) live in `components/brand.tsx`; logo PNGs in `public/brand/`. Provider colors are dots beside the model name.

**Chat themes (Noah's decision, Oct 2026):** the chat screen has a left rail with each AI app's logo (ChatGPT, Claude, Gemini, Grok). Picking one opens that app's own chat list and re-skins the chat to look like that app: `data-theme="<provider>"` on the chat root re-points the tokens (colors, fonts) in `app/globals.css`; layout differences (greeting, composer/bubble shapes, reply font, disclaimer) live in `config/themes.ts`. The model menu in the message box (`components/model-menu.tsx`) lists only that app's models from `config/models.ts`. Logos are files in `public/providers/` set via `logo` in `config/themes.ts`. Auth pages and the rest of the app stay on Orbit Night/Day.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
