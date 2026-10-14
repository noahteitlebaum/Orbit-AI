# Integrations (Jake's App Integration Strategy memo, Oct 12 2026)

Pattern for every connector (`lib/connectors/`): the student signs in on the app's own consent screen with the smallest
read-only permission, picks items, and Orbit bundles them into one Markdown file that enters through the normal upload
path (`attachFiles` → `/api/files` extraction), so it's searchable, cited and usable by all four AIs. Tokens live in the
browser only (memory / session storage; the Zotero key in local storage); nothing is stored on our server. All apps are in
**+ → Add from apps** (grouped Files · Mail & calendar · Notes & research); one whose keys aren't set shows "Not set up".

| App | How | Permission | Setup |
|---|---|---|---|
| GitHub | Paste a repo link (public: no sign-in) or sign in (device code) to list your repos; tick files (suggested: README + source, max 80 files / 400 KB) → `owner-repo@sha.md` with a file tree. `components/github-dialog.tsx`, `/api/github/device` | GitHub App: Contents + Metadata read-only | `NEXT_PUBLIC_GITHUB_CLIENT_ID`, `NEXT_PUBLIC_GITHUB_APP_SLUG` (optional) |
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

**GitHub** (≈5 min) — github.com/settings/apps → New GitHub App: homepage = your site, no callback needed, untick
Webhook, tick **Enable Device Flow**; Repository permissions → Contents: Read-only, Metadata: Read-only; "Any account" can
install. Copy the Client ID → `NEXT_PUBLIC_GITHUB_CLIENT_ID`, the app's URL name → `NEXT_PUBLIC_GITHUB_APP_SLUG`. Students
install the app on the repos they want ("Give Orbit access to more repositories" link in the dialog). Public repos work
with no setup (GitHub allows 60 unauthenticated requests/hour per student IP).

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
