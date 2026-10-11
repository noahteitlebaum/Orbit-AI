# Orbit AI folder helper

Lets the AI in Orbit AI read and edit files in **one folder** on a student's computer. Our server runs on Vercel and
can't reach anyone's computer, so this small program runs locally, and the browser talks to it at `127.0.0.1:47613`.

- Source: `public/helper/orbit-helper.mjs` (no dependencies; developers can run it with Node 18+). Students get the built apps.
- Tests: `helper/orbit-helper.test.ts` (runs with `npm test`).

## Student flow (no terminal, no codes)
1. In the chat, **+ → Connect a folder → Download Orbit Helper** (Windows .exe or Mac .zip; picked from the browser).
2. Open it. First time: a folder picker appears. It then keeps running in the background and opens Orbit AI.
3. The page notices the helper and connects by itself (the helper accepts one connection for 10 minutes after it's opened).
4. Ask the AI to do something with the files. Reads happen automatically; every change shows a preview with **Apply / Skip**.

The helper never starts by itself: after a restart, the student opens Orbit Helper again (their connection is remembered).
Change folder from the app (**Folder → Change folder**), or run it with `--pick`. Stop it with `--stop`.
Settings (folder, hashed tokens) are in `~/.orbit-helper/settings.json`.

## Building the apps
`npm run build:helper` → `public/downloads/` (Windows .exe, Mac .zip for Apple Silicon and Intel). ~22–58 MB each:
better hosted on GitHub Releases; point `NEXT_PUBLIC_HELPER_*_URL` at them (see `config/helper.ts`).
Mac apps are ad-hoc signed (needs `codesign` on a Mac or `rcodesign`), not notarized; Windows isn't code-signed. So
students see a one-time security prompt (Windows: More info → Run anyway; Mac: right-click → Open). A Windows
code-signing certificate and an Apple Developer ID with notarization remove those prompts.

## How a reply with file actions works
1. `POST /api/chat` with `folder: { name }` → the model gets the tools in `lib/folder/tools.ts`.
2. If the model calls tools, the stream ends with `{ t: "tool_calls", replyId, text, calls }` (the reply stays `partial`).
3. The browser runs each call through the helper (`lib/folder/helper-client.ts`); changes are dry-run first, then wait for Apply.
4. The browser calls `/api/chat` again with `run: { replyId, steps }`. That's a new model call with its own budget reservation;
   the text is added to the same reply. Up to 12 rounds (`MAX_TOOL_STEPS`) per message.
5. The actions are saved on the reply as `messages.tool_log` (migration `0004_folder_tools.sql`).

All four providers use their own function-calling format (see each adapter in `lib/providers/`). Gemini's thought
signatures are passed back with each call, which Gemini 3 requires.

## Safety
- Listens on 127.0.0.1 only; checks the `Host` header (DNS rebinding) and the `Origin` (only Orbit AI sites; add more with `--origin`).
- Tools need a token. Tokens are only handed out for 10 minutes after the student opens the helper, to one browser per opening, and are stored hashed.
- A second launch talks to the running helper with a secret from the settings file (no browser can send it).
- Paths must stay inside the folder: `..`, absolute paths and symlinks leading out are refused.
- Only plain-text files can be changed (`.docx` is readable, not editable). Binary files are refused.
- Before any overwrite, edit or delete, the old copy is saved in `<folder>/.orbit-trash/<time>/`.
- Changes run only after the student clicks Apply in the app.

## Known limits / next steps
- Chrome and Edge only. Safari blocks a secure site from calling `http://127.0.0.1`. Chrome may ask the student to allow local network access.
- If the production URL changes, update `APP_URL` in the helper and rebuild.
