// Browser: runs a plugin tool the AI asked for, with the student's own sign-in, and returns text for the model.
// Read-only calls only. If the student isn't signed in, it says so ({ connect }) so the chat can show a Connect button.
import {
  fileText, GitHubError, githubToken, listIssues, loadRepo, myRepos, parseRepoUrl, readIssue, recentCommits, searchCode, searchRepos, isTextPath,
} from "@/lib/connectors/github";
import { googleTokenCached } from "@/lib/connectors/google-drive";
import { googleEvents, MAIL_LIMITS, outlookEvents, readGmail, readOutlook, searchGmail, searchOutlook, type CalEvent, type MailFull, type MailSummary } from "@/lib/connectors/mail-calendar";
import { notionSession, readNotion, searchNotion } from "@/lib/connectors/notion-client";
import { msToken, msTokenSilent, searchOneDrive } from "@/lib/connectors/onedrive";
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
    ? e.map((x) => `- ${x.allDay ? `${x.start.slice(0, 10)} (all day)` : `${when(x.start)} – ${new Date(x.end).toLocaleTimeString("en-CA", { timeStyle: "short" })}`}: ${x.title || "(no title)"}${x.location ? ` @ ${x.location}` : ""}${x.notes ? ` — ${x.notes.replace(/\s+/g, " ").slice(0, 200)}` : ""}`).join("\n")
    : `No events in the next ${n} days.`;

/** Run one plugin tool call. Never throws. */
export async function runPluginTool(name: string, args: Record<string, unknown>): Promise<PluginResult> {
  const id = pluginOfTool(name);
  const plugin = id ? PLUGIN_BY_ID.get(id) : undefined;
  if (!id || !plugin) return { ok: false, error: `Unknown tool ${name}.` };
  const notConnected = (): PluginResult => ({ ok: false, error: `${plugin.name} isn't connected. Ask the student to connect it.`, connect: id });
  try {
    // Sign-in check first, without pop-ups (those need the student's click: the chat shows a Connect button).
    if (plugin.auth === "google" && !googleTokenCached(plugin.scopes ?? [])) return notConnected();
    if (plugin.auth === "microsoft" && !(await msTokenSilent(plugin.scopes ?? []))) return notConnected();
    if (plugin.auth === "notion" && !notionSession()) return notConnected();
    if (plugin.auth === "zotero" && !zoteroAuth()) return notConnected();
    if (isPublicTool(name)) return await viaServer(name, args);
    return { ok: true, output: clip(await call(name, args)) };
  } catch (e) {
    const msg = e instanceof ConnectorError || e instanceof GitHubError ? e.message : "The app didn't respond. Try again.";
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
      return `${ref.owner}/${ref.repo}/${path}${branch ? ` @ ${branch}` : ""}:\n\n${text.slice(0, 60_000)}${text.length > 60_000 ? "\n[cut off]" : ""}`;
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
    case "outlook_search": return mailList(await searchOutlook(str(a.query)));
    case "outlook_read": return mailFull(await readOutlook(list(a.ids).slice(0, MAIL_LIMITS.pick)));
    case "google_calendar_events": { const n = days(a.days); return eventList(await googleEvents(new Date(), n), n); }
    case "outlook_calendar_events": { const n = days(a.days); return eventList(await outlookEvents(new Date(), n), n); }
    // ---------------------------------------------------------------- OneDrive
    case "onedrive_search": {
      const r = (await searchOneDrive(str(a.query))).filter((x) => !x.folder).slice(0, 25);
      return r.length ? r.map((x) => `id: ${x.id}\nname: ${x.name}\nsize: ${Math.max(1, Math.round((x.size ?? 0) / 1000))} KB${x.lastModifiedDateTime ? `\nmodified: ${x.lastModifiedDateTime.slice(0, 10)}` : ""}`).join("\n\n") : "No files found.";
    }
    case "onedrive_read": return readOneDrive(str(a.id));
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
  // Word / PowerPoint / Excel / PDF: turned into text by our server (not stored).
  const out = await fetch("/api/plugins/read", { method: "POST", headers: { "x-file-name": encodeURIComponent(name), "Content-Type": "application/octet-stream" }, body: await res.blob() });
  const j = (await out.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!out.ok || !j.text) throw new ConnectorError(`Couldn't read ${name}${j.error === "too_large" ? " (too large)" : ""}.`);
  return `${name}:\n\n${j.text}`;
}
