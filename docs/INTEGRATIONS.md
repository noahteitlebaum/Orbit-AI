# Integrations (Jake's App Integration Strategy memo, Oct 12 2026)

## Plugins page (sidebar → Plugins), like ChatGPT's
Students install apps once on the **Plugins** page (tabs **Plugins | Skills**, search, Installed, Public / Personal,
Popular and category lists, **+** to install, a details sheet with Connect / Disconnect / "Use in chats" / Uninstall,
the gear for all connections, **Add → Create / Upload skill**). After that **every AI in Orbit uses the app by itself**
when a question needs it — e.g. "what does my orbit-ai repo do?" makes the model call `github_repo_overview` and
`github_read_file`. How it works:
- `lib/plugins/catalog.ts` — each plugin's read-only tools and prompt. `/api/chat` gets `plugins: [ids]` and offers
  those tools; the model's calls come back to the browser (same loop as folder tools, `lib/folder/run.ts`).
- `lib/plugins/run.ts` — the browser runs each call with the student's own sign-in and sends the result back.
  If the app isn't connected yet, the chat shows **Connect <App>** right there and continues after sign-in.
- The steps show above the answer as "Used GitHub and Gmail · 3 steps" (tap to expand).
- Installed plugins/skills are saved to the account (`/api/extensions`, **migration 0013**) and in the browser.
- Sign-ins stay in the browser (GitHub/Notion/Zotero in local storage, Microsoft via MSAL local cache, Google 1-hour
  tokens). Google gives browsers no refresh token, so after an hour the chat asks to Connect Gmail/Calendar again.
- **Skills**: six built-in study skills plus the student's own (or an uploaded SKILL.md). Installed skills are sent
  with each request and added to the system prompt (`lib/plugins/skills.ts`, max 12 / 16k chars).
- Logos: put each app's official logo (from its brand/press page) in `public/plugins/<id>.svg` —
  `github, gmail, google-calendar, google-drive, outlook, outlook-calendar, onedrive, notion, zotero, youtube, wikipedia, arxiv, semantic-scholar, crossref, wolfram`.
  Until then a simple coloured mark is shown.

- **@-mentions**: type `@` in the message box to pick an installed plugin for that message (it's used even if
  switched off for chats). The prompt tells the model the student picked it.
- **Research plugins (no sign-in)**: Wikipedia, arXiv, Semantic Scholar, Crossref. Our server calls them
  (`/api/plugins/public`, fixed hosts only, `lib/plugins/public.ts`); the model is told to look sources up and never
  invent citations. Optional: `SEMANTIC_SCHOLAR_API_KEY` (higher rate limit), `CROSSREF_MAILTO` (Crossref's polite pool).

- **Wolfram|Alpha** (exact maths/science/units): set `WOLFRAM_APP_ID` (free at developer.wolframalpha.com → Get an App
  ID → "LLM API"). Shows "not set up" until then.
- **Sources**: pages, papers, files and issues a plugin opened appear as "Sources" pills under the answer (saved with
  the chat's tool log).
- **+ menu → Plugins**: switch installed plugins on/off for chats without leaving the conversation.

Manual attach still exists: **+ → Add from apps** picks files/emails/pages into a chat.

| App | How | Permission | Setup |
|---|---|---|---|
| GitHub | One-click **Connect GitHub**: GitHub's own "Orbit AI wants access to your GitHub account" page → Authorize; the first time, GitHub asks which repositories (All / Only select). Pop-up callback `/auth/github`, code swapped by `/api/github/oauth` (client secret stays on the server; expiring tokens refreshed). Public repos work without connecting. | GitHub App: Contents, Metadata, Issues, Pull requests read-only | `NEXT_PUBLIC_GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `NEXT_PUBLIC_GITHUB_APP_SLUG` |
| Google Drive | Google Picker; Docs/Sheets/Slides exported to .docx/.xlsx/.pptx | `drive.file` | `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `_PICKER_KEY`, `_APP_ID` |
| OneDrive | MSAL pop-up + Graph browser; redirect page `/auth/microsoft` | `Files.Read` | `NEXT_PUBLIC_MICROSOFT_CLIENT_ID` |
| Outlook mail / calendar | Search inbox, tick up to 10 emails; or next 7/14/30 days of events (`components/mail-dialog.tsx`) | `Mail.Read`, `Calendars.Read` | same Microsoft app |
| Gmail / Google Calendar | Same dialog via Google Identity Services | `gmail.readonly` (restricted), `calendar.readonly` (sensitive) | same Google client; enable Gmail + Calendar APIs |
| Notion | Pop-up consent (student picks pages) → `/auth/notion` → `/api/notion` relays search/read (Notion blocks browser calls) → Markdown | Read content | `NEXT_PUBLIC_NOTION_CLIENT_ID`, `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` |
| Zotero | Student pastes a read-only key once; search library, tick up to 15 → APA reference + abstract + notes + BibTeX | key with library read only | none |
| YouTube | Paste a link; it goes into the message and **Gemini watches the video** (`fileData`, low media resolution ≈100 tokens/s; 60k tokens reserved, settled on real usage). Other apps switch to Gemini. | public videos only | none (Gemini key) |
| ChatGPT / Claude history | Settings → Import (`lib/import/history.ts`, `/api/import`) | own export | migration 0012 |
| Anki / Quizlet | Download → "Flashcards for Anki / Quizlet" | — | — |
| Word / PowerPoint / Excel | Download → .docx (formatted), .pptx (slide per heading, tables/code on their own slides), .xlsx (one sheet per table, numbers and % typed). `lib/export/office.ts`, built in the browser | — | — |

## Setup steps

**GitHub** (≈5 min) — github.com/settings/apps → your app (or New GitHub App):
1. **Callback URL**: `http://localhost:3000/auth/github` and (Add Callback URL) `https://<site>/auth/github`.
2. **Setup URL**: `https://<site>/auth/github`, tick **Redirect on update**. Untick Webhook → Active.
3. Repository permissions → Contents, Metadata, Issues, Pull requests: **Read-only**. Where can it be installed: **Any account**.
4. **Generate a new client secret**. Put Client ID → `NEXT_PUBLIC_GITHUB_CLIENT_ID`, the secret → `GITHUB_CLIENT_SECRET`
   (server only), the app's URL name → `NEXT_PUBLIC_GITHUB_APP_SLUG`. Restart / redeploy.
Students then just click **Connect GitHub** → Authorize (and pick repositories the first time). "Choose repositories"
in the plugin changes the list later. Public repos work with no setup (60 requests/hour per student without connecting).

**Google Drive / Gmail / Calendar** (≈15 min, free)
1. console.cloud.google.com → new project → enable **Google Drive API**, **Google Picker API**, **Gmail API**, **Google Calendar API**.
2. OAuth consent screen: External, "Orbit AI", scopes `drive.file`, `gmail.readonly`, `calendar.readonly`. Add test users while in Testing.
   Before public launch: `calendar.readonly` needs Google's app verification; `gmail.readonly` is *restricted* and needs a
   third-party security assessment (weeks, paid) — keep Gmail to test users until then.
3. Credentials → OAuth client ID (Web) → JavaScript origins `http://localhost:3000` + your Vercel URL.
4. Credentials → API key restricted to the Picker API and your URLs. Project number = `NEXT_PUBLIC_GOOGLE_APP_ID`.

**OneDrive / Outlook** (≈10 min, free)
1. entra.microsoft.com → App registrations → New: any organizational directory + personal accounts.
2. Authentication → **Single-page application** → redirect URIs `http://localhost:3000/auth/microsoft`, `https://<site>/auth/microsoft`.
3. API permissions → Microsoft Graph → Delegated → `Files.Read`, `Mail.Read`, `Calendars.Read`, `User.Read`.
4. Western accounts may need Western IT to approve the app (students then see an "administrator" message; personal accounts work).

**Notion** (≈5 min) — notion.so/profile/integrations → New integration → type **Public**; capabilities: Read content only
(no insert/update, no user emails); redirect URIs `http://localhost:3000/auth/notion` and `https://<site>/auth/notion`.
Copy OAuth client ID (to both `NEXT_PUBLIC_NOTION_CLIENT_ID` and `NOTION_CLIENT_ID`) and the secret (`NOTION_CLIENT_SECRET`, server only).

**Zotero** — nothing to set up. Each student makes a key at zotero.org/settings/keys/new with "Allow library access" only.

## Not built (and why)

| Memo item | Blocker |
|---|---|
| OWL Brightspace | Needs Western IT to register an OAuth app (Valence API). Ask first. |
| Teams | Needs Western tenant admin consent for chat/channel read permissions. |
| Discord | Needs a bot added to each server by its admins; low study value vs. risk. |
| Canva | Canva Connect API needs Canva's partner approval. Students can export a Canva design as PDF and upload it. |
| Google Docs / Word editing | Write access breaks the memo's "read-only first" rule. Orbit creates new Word/PowerPoint/Excel files instead (Download menu). |
