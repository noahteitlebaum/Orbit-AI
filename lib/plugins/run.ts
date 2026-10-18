// Browser: runs a plugin tool the AI asked for, with the student's own sign-in, and returns text for the model.
// Read-only calls, plus gmail_send, which the chat only runs after the student clicks Send. If the student isn't signed in, it says so ({ connect }) so the chat can show a Connect button.
import {
  fileText, githubFilePage, GitHubError, githubToken, listIssues, loadRepo, myRepos, parseRepoUrl, readIssue, recentCommits, searchCode, searchRepos, isTextPath,
} from "@/lib/connectors/github";
import { googleToken, googleTokenCached } from "@/lib/connectors/google-drive";
import { googleEvents, MAIL_LIMITS, sendGmail, draftGmail, modifyGmail, trashGmail, createGoogleEvent, updateGoogleEvent, deleteGoogleEvent, GMAIL_CHANGES, type GmailChange, outlookEvents, readGmail, readOutlook, searchGmail, searchOutlook, type CalEvent, type MailFull, type MailSummary } from "@/lib/connectors/mail-calendar";
import { notionSession, readNotion, searchNotion } from "@/lib/connectors/notion-client";
import { msToken, msTokenSilent, listOneDrive, searchOneDrive } from "@/lib/connectors/onedrive";
import {
  appendExcelRows, createOneDriveFolder, createOutlookEvent, deleteOutlookEvent, draftOutlook, modifyOutlook, moveOneDrive, OUTLOOK_CHANGES,
  renameOneDrive, sendOutlook, trashOneDrive, trashOutlook, updateOutlookEvent, uploadOneDrive, type OutlookChange,
} from "@/lib/connectors/microsoft-actions";
import { ConnectorError } from "@/lib/connectors/types";
import { readZotero, searchZotero, zoteroAuth, zoteroItems } from "@/lib/connectors/zotero";
import { PLUGIN_BY_ID, pluginOfTool, type PluginId } from "./catalog";
import { isPublicTool } from "./public";

/** Research plugins run on our server (some don't allow browser calls). */
async function viaServer(tool: string, args: Record<string, unknown>): Promise<PluginResult> {
  const res = await fetch("/api/plugins/public", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool, args }) }).catch(() => null);
  const j = (await res?.json().catch(() => ({}))) as { output?: string; error?: string } | undefined;
  if (res?.ok && typeof j?.output === "string") return { ok: true, output: clip(j.output) };
  return { ok: false, error: j?.error ?? "The service didn't respond. Try again." };
}

export type PluginResult = { ok: true; output: string } | { ok: false; error: string; connect?: PluginId };

const MAX_OUT = 50_000;
const clip = (s: string, n = MAX_OUT) => (s.length > n ? `${s.slice(0, n)}\n[cut off]` : s);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const list = (v: unknown) => str(v).split(/[\s,]+/).filter(Boolean);
const days = (v: unknown) => Math.min(60, Math.max(1, Number(v) || MAIL_LIMITS.days));
const when = (iso: string) => (Number.isNaN(+new Date(iso)) ? iso : new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }));

function repoArg(v: unknown): { owner: string; repo: string } {
  const r = parseRepoUrl(str(v));
  if (!r) throw new ConnectorError('Give the repository as "owner/name".');
  return { owner: r.owner, repo: r.repo };
}

const mailList = (m: MailSummary[]) =>
  m.length ? m.map((x) => `id: ${x.id}\nfrom: ${x.from}\nsubject: ${x.subject || "(no subject)"}\ndate: ${when(x.date)}\n${x.snippet}`).join("\n\n") : "No emails found.";
const mailFull = (m: MailFull[]) =>
  m.map((x) => `From: ${x.from}\nTo: ${x.to}\nDate: ${when(x.date)}\nSubject: ${x.subject || "(no subject)"}\n\n${x.body.trim().slice(0, MAIL_LIMITS.bodyChars) || x.snippet}`).join("\n\n---\n\n");
const eventList = (e: CalEvent[], n: number) =>
  e.length
    ? e.map((x) => `- ${x.id ? `[id ${x.id}] ` : ""}${x.allDay ? `${x.start.slice(0, 10)} (all day)` : `${when(x.start)} – ${new Date(x.end).toLocaleTimeString("en-CA", { timeStyle: "short" })}`}: ${x.title || "(no title)"}${x.location ? ` @ ${x.location}` : ""}${x.notes ? ` — ${x.notes.replace(/\s+/g, " ").slice(0, 200)}` : ""}`).join("\n")
    : `No events in the next ${n} days.`;

/** Run one plugin tool call. Never throws. */
export async function runPluginTool(name: string, args: Record<string, unknown>): Promise<PluginResult> {
  const id = pluginOfTool(name);
  const plugin = id ? PLUGIN_BY_ID.get(id) : undefined;
  if (!id || !plugin) return { ok: false, error: `Unknown tool ${name}.` };
  const notConnected = (): PluginResult => ({ ok: false, error: `${plugin.name} isn't connected. Ask the student to connect it.`, connect: id });
  try {
    // Sign-in check first, without pop-ups (those need the student's click: the chat shows a Connect button).
    // Sending asks Google for send permission itself (the student just clicked Send, so its pop-up is allowed).
    if (plugin.auth === "google" && !plugin.tools.some((t) => t.name === name && t.write) && !googleTokenCached(plugin.scopes ?? [])) return notConnected();
    if (plugin.auth === "microsoft" && !plugin.tools.some((t) => t.name === name && t.write) && !(await msTokenSilent(plugin.scopes ?? []))) return notConnected();
    if (plugin.auth === "notion" && !notionSession()) return notConnected();
    if (plugin.auth === "zotero" && !zoteroAuth()) return notConnected();
    if (isPublicTool(name)) return await viaServer(name, args);
    return { ok: true, output: clip(await call(name, args)) };
  } catch (e) {
    const msg = e instanceof ConnectorError || e instanceof GitHubError ? e.message : "The app didn't respond. Try again.";
    if (plugin.tools.some((t) => t.name === name && t.write)) return { ok: false, error: /cancel|blocked/i.test(msg) ? "The student closed Google's permission window, so nothing was changed." : msg };
    if (/sign in again|expired|didn't allow access/i.test(msg) && plugin.auth !== "github") return { ok: false, error: msg, connect: id };
    if (/needs GitHub sign-in/i.test(msg)) return { ok: false, error: msg, connect: id };
    return { ok: false, error: msg };
  }
}

async function call(name: string, a: Record<string, unknown>): Promise<string> {
  const token = githubToken();
  switch (name) {
    // ---------------------------------------------------------------- GitHub
    case "github_my_repos": {
      if (!token) throw new GitHubError("Listing your repositories needs GitHub sign-in. Connect GitHub in Plugins.");
      const r = await myRepos(token);
      return r.length ? r.slice(0, 60).map((x) => `${x.fullName}${x.private ? " (private)" : ""} — pushed ${x.pushedAt.slice(0, 10)}${x.description ? ` — ${x.description}` : ""}`).join("\n") : "No repositories (the Orbit GitHub app may need access to them).";
    }
    case "github_search_repos": {
      const r = await searchRepos(str(a.query));
      return r.length ? r.map((x) => `${x.fullName} ★${x.stars}${x.language ? ` · ${x.language}` : ""}${x.description ? ` — ${x.description}` : ""}`).join("\n") : "No repositories found.";
    }
    case "github_repo_overview": {
      const ref = repoArg(a.repo);
      const under = str(a.path).replace(/^\/+|\/+$/g, "");
      const info = await loadRepo(ref, token);
      const files = info.tree.filter((f) => isTextPath(f.path) && (!under || f.path.startsWith(`${under}/`)));
      const readme = info.tree.find((f) => /^readme(\.\w+)?$/i.test(f.path));
      const readmeText = readme ? await fileText(info, readme.path, token).catch(() => "") : "";
      return [
        `${info.owner}/${info.repo} (${info.private ? "private" : "public"}), branch ${info.ref} @ ${info.commit.slice(0, 7)}`,
        info.description ?? "", info.htmlUrl, "",
        `Files${under ? ` under ${under}/` : ""} (${files.length}${info.truncated ? ", list truncated by GitHub" : ""}):`,
        files.slice(0, 500).map((f) => `${f.path} (${Math.max(1, Math.round(f.size / 1000))} KB)`).join("\n"),
        files.length > 500 ? `… ${files.length - 500} more (call again with a path)` : "",
        readmeText ? `\n${readme!.path}:\n${readmeText.slice(0, 8000)}` : "",
      ].filter((x) => x !== "").join("\n");
    }
    case "github_read_file": {
      const ref = repoArg(a.repo);
      const path = str(a.path).replace(/^\/+/, "");
      if (!path) throw new ConnectorError("Which file? Give its path.");
      const branch = str(a.ref);
      const text = await fileText({ owner: ref.owner, repo: ref.repo, commit: branch, private: false }, path, token);
      return `${ref.owner}/${ref.repo}/${path}${branch ? ` @ ${branch}` : ""}:\n\n${githubFilePage(text, a)}`;
    }
    case "github_search_code": {
      const repo = str(a.repo) ? `${repoArg(a.repo).owner}/${repoArg(a.repo).repo}` : undefined;
      const r = await searchCode(str(a.query), repo, token);
      return r.length ? r.map((x) => `${x.repo}/${x.path}`).join("\n") : "No matches.";
    }
    case "github_list_issues": {
      const ref = repoArg(a.repo);
      const state = (["open", "closed", "all"] as const).find((s) => s === str(a.state)) ?? "open";
      const kind = (["issues", "prs", "all"] as const).find((s) => s === str(a.kind)) ?? "all";
      const r = await listIssues(ref.owner, ref.repo, { state, kind }, token);
      return r.length
        ? r.map((i) => `#${i.number} [${i.pr ? "PR" : "issue"}, ${i.state}] ${i.title} — ${i.author}, ${i.comments} comments, updated ${i.updated.slice(0, 10)}${i.labels.length ? ` (${i.labels.join(", ")})` : ""}`).join("\n")
        : `No ${state === "all" ? "" : `${state} `}${kind === "prs" ? "pull requests" : kind === "issues" ? "issues" : "issues or pull requests"}.`;
    }
    case "github_read_issue": {
      const ref = repoArg(a.repo);
      const num = Number(a.number);
      if (!Number.isInteger(num) || num < 1) throw new ConnectorError("Give the issue or pull request number.");
      return readIssue(ref.owner, ref.repo, num, token);
    }
    case "github_recent_commits": {
      const ref = repoArg(a.repo);
      return recentCommits(ref.owner, ref.repo, token);
    }
    // ---------------------------------------------------------------- mail & calendar
    case "gmail_search": return mailList(await searchGmail(str(a.query)));
    case "gmail_read": return mailFull(await readGmail(list(a.ids).slice(0, MAIL_LIMITS.pick)));
    case "gmail_create_draft": {
      await draftGmail({ to: str(a.to), cc: str(a.cc), subject: str(a.subject), body: typeof a.body === "string" ? a.body : "", replyTo: str(a.reply_to) || undefined });
      return `Saved as a draft in Gmail${str(a.to) ? ` (to ${str(a.to)})` : ""}. It wasn't sent.`;
    }
    case "gmail_modify": {
      const change = GMAIL_CHANGES.find((c) => c === str(a.change));
      if (!change) throw new ConnectorError(`Unknown change. Use one of: ${GMAIL_CHANGES.join(", ")}.`);
      return modifyGmail(list(a.ids), change as GmailChange, str(a.label));
    }
    case "gmail_trash": return trashGmail(list(a.ids));
    case "google_calendar_create_event": return createGoogleEvent({ title: str(a.title), start: str(a.start), end: str(a.end), location: str(a.location), description: str(a.description) });
    case "google_calendar_update_event": return updateGoogleEvent(str(a.id), { title: str(a.title), start: str(a.start), end: str(a.end), location: str(a.location), description: str(a.description) });
    case "google_calendar_delete_event": return deleteGoogleEvent(str(a.id));
    case "gmail_send": {
      const sent = await sendGmail({ to: str(a.to), cc: str(a.cc), subject: str(a.subject), body: typeof a.body === "string" ? a.body : "", replyTo: str(a.reply_to) || undefined });
      return `Sent to ${sent.to.join(", ")}${str(a.subject) ? ` (subject: ${str(a.subject)})` : ""}.`;
    }
    case "outlook_search": return mailList(await searchOutlook(str(a.query)));
    case "outlook_read": return mailFull(await readOutlook(list(a.ids).slice(0, MAIL_LIMITS.pick)));
    case "google_calendar_events": { const n = days(a.days); return eventList(await googleEvents(new Date(), n), n); }
    case "outlook_send": return sendOutlook({ to: str(a.to), cc: str(a.cc), subject: str(a.subject), body: typeof a.body === "string" ? a.body : "", replyTo: str(a.reply_to) || undefined });
    case "outlook_create_draft": return draftOutlook({ to: str(a.to), cc: str(a.cc), subject: str(a.subject), body: typeof a.body === "string" ? a.body : "", replyTo: str(a.reply_to) || undefined });
    case "outlook_modify": {
      const change = OUTLOOK_CHANGES.find((c) => c === str(a.change));
      if (!change) throw new ConnectorError(`Unknown change. Use one of: ${OUTLOOK_CHANGES.join(", ")}.`);
      return modifyOutlook(list(a.ids), change as OutlookChange, str(a.category));
    }
    case "outlook_trash": return trashOutlook(list(a.ids));
    case "outlook_calendar_create_event": return createOutlookEvent({ title: str(a.title), start: str(a.start), end: str(a.end), location: str(a.location), description: str(a.description) });
    case "outlook_calendar_update_event": return updateOutlookEvent(str(a.id), { title: str(a.title), start: str(a.start), end: str(a.end), location: str(a.location), description: str(a.description) });
    case "outlook_calendar_delete_event": return deleteOutlookEvent(str(a.id));
    case "outlook_calendar_events": { const n = days(a.days); return eventList(await outlookEvents(new Date(), n), n); }
    // ---------------------------------------------------------------- Google Drive
    case "google_drive_search": {
      const r = await searchDrive(str(a.query));
      return r.length ? r.map((f) => `id: ${f.id}\ntitle: ${f.name}\ntype: ${driveKind(f.mimeType)}${f.modifiedTime ? `\nmodified: ${f.modifiedTime.slice(0, 10)}` : ""}${f.webViewLink ? `\nlink: ${f.webViewLink}` : ""}`).join("\n\n") : "No files found.";
    }
    case "google_drive_read": return readDrive(str(a.id));
    case "google_drive_rename": return renameDrive(str(a.id), str(a.new_name));
    case "google_drive_create_doc": return createDoc(str(a.title), typeof a.content === "string" ? a.content : "");
    case "google_drive_edit_doc": return editDoc(str(a.id), str(a.mode) === "replace" ? "replace" : "append", typeof a.text === "string" ? a.text : "");
    case "google_drive_create_sheet": return createSheet(str(a.title), typeof a.rows === "string" ? a.rows : "");
    case "google_sheets_append_rows": return writeSheet(str(a.id), "append", str(a.sheet), typeof a.rows === "string" ? a.rows : "");
    case "google_sheets_update_cells": return writeSheet(str(a.id), "update", str(a.range), typeof a.rows === "string" ? a.rows : "");
    case "google_drive_create_folder": return createFolder(str(a.name), str(a.parent_id));
    case "google_drive_move": return moveDrive(str(a.id), str(a.folder_id));
    case "google_drive_trash": return trashDrive(str(a.id));
    // ---------------------------------------------------------------- OneDrive
    case "onedrive_search": {
      const r = (await searchOneDrive(str(a.query))).slice(0, 25);
      return r.length ? r.map((x) => `id: ${x.id}\nname: ${x.name}\n${x.folder ? `type: folder (${x.folder.childCount ?? 0} items)` : `size: ${Math.max(1, Math.round((x.size ?? 0) / 1000))} KB`}${x.lastModifiedDateTime ? `\nmodified: ${x.lastModifiedDateTime.slice(0, 10)}` : ""}`).join("\n\n") : "No files found.";
    }
    case "onedrive_read": return readOneDrive(str(a.id));
    case "onedrive_list_folder": {
      const items = await listOneDrive(str(a.id) || null);
      return items.length ? items.map((x) => `id: ${x.id} · ${x.name}${x.folder ? " (folder)" : ""}`).join("\n") : "This folder is empty.";
    }
    case "onedrive_rename": return renameOneDrive(str(a.id), str(a.new_name));
    case "onedrive_create_folder": return createOneDriveFolder(str(a.name), str(a.parent_id));
    case "onedrive_move": return moveOneDrive(str(a.id), str(a.folder_id));
    case "onedrive_trash": return trashOneDrive(str(a.id));
    case "onedrive_create_word_doc": {
      const { docxBlob } = await import("@/lib/export/office");
      const title = str(a.title) || "Untitled";
      return uploadOneDrive({ folder: str(a.folder_id), name: `${title.replace(/\.docx$/i, "")}.docx` }, await docxBlob(title, typeof a.content === "string" ? a.content : ""));
    }
    case "onedrive_save_text_file": {
      const text = typeof a.content === "string" ? a.content : "";
      return uploadOneDrive(str(a.id) ? { id: str(a.id) } : { folder: str(a.folder_id), name: str(a.name) || "Untitled.txt" }, new Blob([text], { type: "text/plain" }));
    }
    case "excel_append_rows": return appendExcelRows(str(a.id), parseCsv(typeof a.rows === "string" ? a.rows : ""), str(a.sheet));
    // ---------------------------------------------------------------- Notion, Zotero
    case "notion_search": {
      const r = await searchNotion(notionSession()!.token, str(a.query));
      return r.length ? r.map((p) => `id: ${p.id}\ntitle: ${p.title}\nkind: ${p.kind}\nedited: ${p.edited.slice(0, 10)}\n${p.url}`).join("\n\n") : "No pages found. The student may need to share pages with Orbit in Notion.";
    }
    case "notion_read_page": {
      const kind = str(a.kind) === "database" ? "database" : "page";
      const [p] = await readNotion(notionSession()!.token, [{ id: str(a.id), kind }]);
      return p ? `${p.title}\n${p.url}\n\n${p.markdown}` : "Page not found.";
    }
    case "zotero_search": {
      const r = await searchZotero(zoteroAuth()!, str(a.query));
      return r.length ? r.map((i) => `key: ${i.key}\ntitle: ${i.title}\nauthors: ${i.creators.map((c) => c.lastName ?? c.name).filter(Boolean).join(", ")}\nyear: ${i.date?.match(/\d{4}/)?.[0] ?? "n.d."}${i.publicationTitle ? `\nin: ${i.publicationTitle}` : ""}`).join("\n\n") : "Nothing in the library matches.";
    }
    case "zotero_read": {
      const auth = zoteroAuth()!;
      const items = await zoteroItems(auth, list(a.keys));
      return items.length ? readZotero(auth, items) : "No items with those keys.";
    }
    default: throw new ConnectorError(`Unknown tool ${name}.`);
  }
}

const TEXTY = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|js|jsx|ts|tsx|py|ipynb|java|c|h|cpp|cs|go|rs|rb|php|swift|kt|r|sql|sh|tex|bib|log)$/i;
const DOCS = /\.(pdf|docx|pptx|xlsx|xls)$/i;
async function readOneDrive(id: string): Promise<string> {
  if (!/^[\w!.-]{5,200}$/.test(id)) throw new ConnectorError("Give a file id from onedrive_search.");
  const token = await msToken(["Files.Read"], "OneDrive");
  const meta = (await (await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(id)}?$select=id,name,size,file,@microsoft.graph.downloadUrl`, { headers: { Authorization: `Bearer ${token}` } })).json()) as
    { name?: string; size?: number; "@microsoft.graph.downloadUrl"?: string };
  const name = meta.name ?? "file";
  if (!meta["@microsoft.graph.downloadUrl"]) throw new ConnectorError(`Couldn't open ${name}.`);
  if ((meta.size ?? 0) > 15 * 1024 * 1024) throw new ConnectorError(`${name} is too large to read (over 15 MB).`);
  const res = await fetch(meta["@microsoft.graph.downloadUrl"]);
  if (!res.ok) throw new ConnectorError(`Couldn't download ${name}.`);
  if (TEXTY.test(name)) return `${name}:\n\n${(await res.text()).slice(0, 60_000)}`;
  if (!DOCS.test(name)) throw new ConnectorError(`${name} isn't a file the AI can read (text, Word, PowerPoint, Excel or PDF).`);
  return `${name}:\n\n${await extractText(name, await res.blob())}`;
}

/** Word / PowerPoint / Excel / PDF → text, by our server (not stored). */
async function extractText(name: string, blob: Blob): Promise<string> {
  const out = await fetch("/api/plugins/read", { method: "POST", headers: { "x-file-name": encodeURIComponent(name), "Content-Type": "application/octet-stream" }, body: blob });
  const j = (await out.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!out.ok || !j.text) throw new ConnectorError(`Couldn't read ${name}${j.error === "too_large" ? " (too large)" : j.error === "unsupported" ? " (not a file type the AI can read)" : ""}.`);
  return j.text;
}

// ---------------------------------------------------------------- Google Drive (drive.readonly)
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const DRIVE_SCOPE = ["https://www.googleapis.com/auth/drive.readonly"];
type DriveFile = { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string; size?: string };
const G = "application/vnd.google-apps.";
const OOXML = "application/vnd.openxmlformats-officedocument.";
// Google's own files are exported: Docs and Slides as text, Sheets as Excel (every tab), Drawings aren't readable.
const EXPORT: Record<string, { mime: string; ext: string }> = {
  [`${G}document`]: { mime: "text/plain", ext: "txt" },
  [`${G}presentation`]: { mime: "text/plain", ext: "txt" },
  [`${G}spreadsheet`]: { mime: `${OOXML}spreadsheetml.sheet`, ext: "xlsx" },
};
export function driveKind(mime: string): string {
  const k: Record<string, string> = { [`${G}document`]: "Google Doc", [`${G}spreadsheet`]: "Google Sheet", [`${G}presentation`]: "Google Slides", [`${G}folder`]: "folder", "application/pdf": "PDF",
    [`${OOXML}wordprocessingml.document`]: "Word", [`${OOXML}presentationml.presentation`]: "PowerPoint", [`${OOXML}spreadsheetml.sheet`]: "Excel" };
  return k[mime] ?? (mime.startsWith("image/") ? "image" : mime.startsWith("text/") ? "text" : mime.replace(G, "Google "));
}
async function driveFetch(url: string, init: RequestInit = {}, scopes = DRIVE_SCOPE): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await googleToken(scopes)}` } }).catch(() => null);
  if (!res) throw new ConnectorError("Couldn't reach Google Drive. Try again.");
  if (res.status === 401) throw new ConnectorError("Google Drive sign-in expired. Sign in again.");
  if (res.status === 403) {
    const reason = ((await res.clone().json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[] } }).error?.errors?.[0]?.reason;
    if (reason === "insufficientFilePermissions") throw new ConnectorError("You only have view access to that file, so it can't be renamed.");
    throw new ConnectorError(reason === "exportSizeLimitExceeded" ? "That file is too large for Google to export." : reason === "accessNotConfigured" ? "The Google Drive API isn't turned on for Orbit yet (admin: enable it in Google Cloud)." : "Google Drive didn't allow access. Sign in again.");
  }
  if (res.status === 404) throw new ConnectorError("File not found (it may have been deleted or not shared with you).");
  if (!res.ok) throw new ConnectorError(`Google Drive returned an error (${res.status}).`);
  return res;
}
/** Drive's query language: escape quotes and backslashes in the student's words. Pure. */
export const driveQuery = (q: string) => {
  const words = q.trim().slice(0, 200).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return words ? `(name contains '${words}' or fullText contains '${words}') and trashed = false` : "trashed = false";
};
async function searchDrive(q: string): Promise<DriveFile[]> {
  const fields = "files(id,name,mimeType,modifiedTime,webViewLink,size)";
  const order = q.trim() ? "" : "&orderBy=modifiedTime desc"; // Drive can't sort full-text results
  const j = (await (await driveFetch(`${DRIVE}?pageSize=20&q=${encodeURIComponent(driveQuery(q))}&fields=${encodeURIComponent(fields)}${order}&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json()) as { files?: DriveFile[] };
  return j.files ?? [];
}
async function readDrive(id: string): Promise<string> {
  if (!/^[\w-]{10,200}$/.test(id)) throw new ConnectorError("Give a file id from google_drive_search.");
  const f = (await (await driveFetch(`${DRIVE}/${id}?fields=id,name,mimeType,size,webViewLink&supportsAllDrives=true`)).json()) as DriveFile;
  const head = `${f.name}\n${f.webViewLink ?? ""}\n(${driveKind(f.mimeType)})\n\n`;
  if (f.mimeType === `${G}folder`) {
    const kids = (await (await driveFetch(`${DRIVE}?pageSize=100&q=${encodeURIComponent(`'${id}' in parents and trashed = false`)}&fields=${encodeURIComponent("files(id,name,mimeType,modifiedTime)")}&orderBy=folder,name&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json()) as { files?: DriveFile[] };
    return head + ((kids.files ?? []).map((k) => `id: ${k.id} · ${k.name} (${driveKind(k.mimeType)})`).join("\n") || "This folder is empty.");
  }
  const exp = EXPORT[f.mimeType];
  if (exp) {
    const res = await driveFetch(`${DRIVE}/${id}/export?mimeType=${encodeURIComponent(exp.mime)}`);
    if (exp.ext === "txt") return head + clip((await res.text()).trim(), 60_000);
    return head + await extractText(`${f.name}.${exp.ext}`, await res.blob());
  }
  if (f.mimeType.startsWith(G)) throw new ConnectorError(`${f.name} is a ${driveKind(f.mimeType)}, which the AI can't read.`);
  if (Number(f.size ?? 0) > 15 * 1024 * 1024) throw new ConnectorError(`${f.name} is too large to read (over 15 MB).`);
  const res = await driveFetch(`${DRIVE}/${id}?alt=media&supportsAllDrives=true`);
  if (TEXTY.test(f.name) || f.mimeType.startsWith("text/")) return head + clip(await res.text(), 60_000);
  return head + await extractText(f.name, await res.blob());
}

// Changes (only after the student confirms in the chat). Renaming any file needs the full Drive permission; creating
// a Doc only needs drive.file (files Orbit made). Google asks for each the first time.
const DRIVE_EDIT_SCOPE = ["https://www.googleapis.com/auth/drive"];
const DRIVE_FILE_SCOPE = ["https://www.googleapis.com/auth/drive.file"];
async function renameDrive(id: string, name: string): Promise<string> {
  if (!/^[\w-]{10,200}$/.test(id)) throw new ConnectorError("Give a file id from google_drive_search.");
  const clean = name.replace(/[\r\n]+/g, " ").trim().slice(0, 250);
  if (!clean) throw new ConnectorError("What should the new name be?");
  const res = await driveFetch(`${DRIVE}/${id}?fields=id,name,webViewLink&supportsAllDrives=true`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: clean }),
  }, DRIVE_EDIT_SCOPE);
  const f = (await res.json()) as DriveFile;
  return `Renamed to "${f.name}".\n${f.webViewLink ?? ""}`;
}
async function createDoc(title: string, content: string): Promise<string> {
  const name = title.replace(/[\r\n]+/g, " ").trim().slice(0, 250) || "Untitled";
  const boundary = `orbit${Math.random().toString(36).slice(2)}`;
  const body = [`--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", JSON.stringify({ name, mimeType: `${G}document` }),
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", content, `--${boundary}--`].join("\r\n");
  const res = await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  }, DRIVE_FILE_SCOPE);
  const f = (await res.json()) as DriveFile;
  return `Created the Google Doc "${f.name}".\n${f.webViewLink ?? ""}`;
}

const ID = /^[\w-]{10,200}$/;
const needId = (id: string, what = "file") => { if (!ID.test(id)) throw new ConnectorError(`Give a ${what} id from google_drive_search.`); };
/** Simple CSV (quotes, commas, newlines in quotes) → rows. Pure. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim())).slice(0, 2000);
}
const multipart = (meta: object, mime: string, content: string) => {
  const boundary = `orbit${Math.random().toString(36).slice(2)}`;
  return { boundary, body: [`--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", JSON.stringify(meta), `--${boundary}`, `Content-Type: ${mime}; charset=UTF-8`, "", content, `--${boundary}--`].join("\r\n") };
};
async function editDoc(id: string, mode: "append" | "replace", text: string): Promise<string> {
  needId(id, "Doc");
  if (!text.trim()) throw new ConnectorError("What text should go in the doc?");
  const f = (await (await driveFetch(`${DRIVE}/${id}?fields=name,mimeType,webViewLink&supportsAllDrives=true`)).json()) as DriveFile;
  if (f.mimeType !== `${G}document`) throw new ConnectorError(`${f.name} isn't a Google Doc, so it can't be edited here.`);
  if (mode === "replace") {
    await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&supportsAllDrives=true`, { method: "PATCH", headers: { "Content-Type": "text/plain; charset=UTF-8" }, body: text }, DRIVE_EDIT_SCOPE);
    return `Replaced the text of "${f.name}".\n${f.webViewLink ?? ""}`;
  }
  await driveFetch(`https://docs.googleapis.com/v1/documents/${id}:batchUpdate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ insertText: { endOfSegmentLocation: {}, text: `\n${text}` } }] }),
  }, DRIVE_EDIT_SCOPE);
  return `Added the text to the end of "${f.name}".\n${f.webViewLink ?? ""}`;
}
async function createSheet(title: string, rows: string): Promise<string> {
  const name = title.replace(/[\r\n]+/g, " ").trim().slice(0, 250) || "Untitled spreadsheet";
  const m = multipart({ name, mimeType: `${G}spreadsheet` }, "text/csv", rows);
  const res = await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${m.boundary}` }, body: m.body }, DRIVE_FILE_SCOPE);
  const f = (await res.json()) as DriveFile;
  return `Created the Google Sheet "${f.name}" (id ${f.id}).\n${f.webViewLink ?? ""}`;
}
async function writeSheet(id: string, how: "append" | "update", where: string, csv: string): Promise<string> {
  needId(id, "Sheet");
  const values = parseCsv(csv);
  if (!values.length) throw new ConnectorError("No rows to write.");
  const range = how === "append" ? (where ? `'${where.replace(/'/g, "''")}'!A1` : "A1") : where;
  if (!range || !/^('?[^!]{1,100}'?!)?[A-Z]{1,3}\d*(:[A-Z]{1,3}\d*)?$/i.test(range)) throw new ConnectorError('Give the cells as a range, e.g. "Sheet1!A2:C5".');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}${how === "append" ? ":append?insertDataOption=INSERT_ROWS&" : "?"}valueInputOption=USER_ENTERED`;
  const res = await driveFetch(url, { method: how === "append" ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) }, DRIVE_EDIT_SCOPE);
  const j = (await res.json()) as { updates?: { updatedRange?: string }; updatedRange?: string };
  return `${how === "append" ? "Added" : "Updated"} ${values.length} row${values.length === 1 ? "" : "s"} (${j.updates?.updatedRange ?? j.updatedRange ?? range}).\nhttps://docs.google.com/spreadsheets/d/${id}`;
}
async function createFolder(name: string, parent: string): Promise<string> {
  const clean = name.replace(/[\r\n]+/g, " ").trim().slice(0, 250);
  if (!clean) throw new ConnectorError("What should the folder be called?");
  if (parent) needId(parent, "folder");
  const res = await driveFetch(`${DRIVE}?fields=id,name,webViewLink&supportsAllDrives=true`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: clean, mimeType: `${G}folder`, ...(parent ? { parents: [parent] } : {}) }),
  }, DRIVE_EDIT_SCOPE);
  const f = (await res.json()) as DriveFile;
  return `Created the folder "${f.name}" (id ${f.id}).\n${f.webViewLink ?? ""}`;
}
async function moveDrive(id: string, folder: string): Promise<string> {
  needId(id);
  needId(folder, "folder");
  const f = (await (await driveFetch(`${DRIVE}/${id}?fields=name,parents&supportsAllDrives=true`)).json()) as DriveFile & { parents?: string[] };
  const res = await driveFetch(`${DRIVE}/${id}?addParents=${folder}${f.parents?.length ? `&removeParents=${f.parents.join(",")}` : ""}&fields=id,name,webViewLink&supportsAllDrives=true`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}",
  }, DRIVE_EDIT_SCOPE);
  const out = (await res.json()) as DriveFile;
  return `Moved ${out.name ?? f.name ? `"${out.name ?? f.name}"` : "it"}.\n${out.webViewLink ?? ""}`;
}
async function trashDrive(id: string): Promise<string> {
  needId(id);
  const res = await driveFetch(`${DRIVE}/${id}?fields=id,name&supportsAllDrives=true`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) }, DRIVE_EDIT_SCOPE);
  const f = (await res.json()) as DriveFile;
  return `Moved ${f.name ? `"${f.name}"` : "it"} to Drive's Trash (recoverable for 30 days).`;
}
