// Notion connector (integration memo #8): read-only. Notion's API doesn't allow calls from browsers, so
// /api/notion relays them with the student's own token (kept in their tab, never stored by Orbit). The student picks
// which pages Notion shares with Orbit on Notion's consent screen, then ticks pages here; each page becomes Markdown.
// This file: pure converters (tested) + the server calls used by the route.
export const NOTION_LIMITS = { pick: 10, blocks: 1500, depth: 3, chars: 120_000 };
const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

type RichText = { plain_text: string; href?: string | null; type?: string; annotations?: { bold?: boolean; italic?: boolean; code?: boolean; strikethrough?: boolean }; equation?: { expression: string } };
export type NotionBlock = { id: string; type: string; has_children?: boolean; children?: NotionBlock[] } & Record<string, unknown>;
export type NotionPage = { id: string; title: string; url: string; edited: string; icon: string | null; kind: "page" | "database" };

/** Notion rich text → Markdown inline text. Pure. */
export function richText(parts: RichText[] | undefined): string {
  return (parts ?? []).map((p) => {
    if (p.type === "equation" && p.equation) return `$${p.equation.expression}$`;
    let t = p.plain_text;
    if (!t) return "";
    const a = p.annotations ?? {};
    if (a.code) t = `\`${t}\``;
    if (a.bold) t = `**${t}**`;
    if (a.italic) t = `*${t}*`;
    if (a.strikethrough) t = `~~${t}~~`;
    if (p.href) t = `[${t}](${p.href})`;
    return t;
  }).join("");
}

/** Notion blocks (children already attached) → Markdown. Pure. */
export function blocksToMarkdown(blocks: NotionBlock[], indent = ""): string {
  const out: string[] = [];
  let n = 0;
  for (const b of blocks) {
    const v = (b[b.type] ?? {}) as { rich_text?: RichText[]; checked?: boolean; language?: string; expression?: string; caption?: RichText[]; title?: string; url?: string; cells?: RichText[][]; icon?: { emoji?: string } };
    const text = richText(v.rich_text);
    n = b.type === "numbered_list_item" ? n + 1 : 0;
    const kids = b.children?.length ? blocksToMarkdown(b.children, `${indent}  `) : "";
    switch (b.type) {
      case "heading_1": out.push(`${indent}# ${text}`); break;
      case "heading_2": out.push(`${indent}## ${text}`); break;
      case "heading_3": out.push(`${indent}### ${text}`); break;
      case "bulleted_list_item": out.push(`${indent}- ${text}`); break;
      case "numbered_list_item": out.push(`${indent}${n}. ${text}`); break;
      case "to_do": out.push(`${indent}- [${v.checked ? "x" : " "}] ${text}`); break;
      case "toggle": out.push(`${indent}- ${text}`); break;
      case "quote": out.push(`${indent}> ${text}`); break;
      case "callout": out.push(`${indent}> ${v.icon?.emoji ? `${v.icon.emoji} ` : ""}${text}`); break;
      case "code": out.push(`${indent}\`\`\`${v.language && v.language !== "plain text" ? v.language : ""}\n${text}\n${indent}\`\`\``); break;
      case "equation": out.push(`${indent}$$${v.expression ?? ""}$$`); break;
      case "divider": out.push(`${indent}---`); break;
      case "child_page": out.push(`${indent}**Subpage:** ${v.title ?? ""}`); break;
      case "child_database": out.push(`${indent}**Database:** ${v.title ?? ""}`); break;
      case "bookmark": case "embed": case "link_preview": if (v.url) out.push(`${indent}<${v.url}>`); break;
      case "image": case "video": case "file": case "pdf": { const c = richText(v.caption); out.push(`${indent}[${b.type}${c ? `: ${c}` : ""}]`); break; }
      case "table": {
        const rows = (b.children ?? []).map((r) => ((r.table_row as { cells?: RichText[][] })?.cells ?? []).map((c) => richText(c).replace(/\|/g, "\\|")));
        if (rows.length) {
          out.push([`${indent}| ${rows[0].join(" | ")} |`, `${indent}|${rows[0].map(() => " --- ").join("|")}|`, ...rows.slice(1).map((r) => `${indent}| ${r.join(" | ")} |`)].join("\n"));
        }
        continue; // rows already used
      }
      default: if (text) out.push(`${indent}${text}`);
    }
    if (kids && b.type !== "table") out.push(kids);
  }
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n");
}

/** One Markdown file for the picked pages. Pure. */
export function bundleNotion(pages: { title: string; url: string; markdown: string }[]): string {
  const head = `# Notion: ${pages.length} page${pages.length === 1 ? "" : "s"}\n\nImported into Orbit on ${new Date().toISOString().slice(0, 10)} (read-only copy).`;
  return [head, ...pages.map((p) => `## ${p.title || "Untitled"}\n\nSource: ${p.url}\n\n${p.markdown.length > NOTION_LIMITS.chars ? `${p.markdown.slice(0, NOTION_LIMITS.chars)}\n\n[…cut: page too long]` : p.markdown}`)].join("\n\n---\n\n") + "\n";
}

type RawPage = { id: string; object: "page" | "database"; url: string; last_edited_time: string; icon?: { emoji?: string } | null; title?: RichText[]; properties?: Record<string, { type: string; title?: RichText[] }> };
export function pageTitle(p: RawPage): string {
  if (p.object === "database") return richText(p.title) || "Untitled";
  const prop = Object.values(p.properties ?? {}).find((x) => x.type === "title");
  return richText(prop?.title).replace(/\*|`|~~/g, "") || "Untitled";
}

// ---------------------------------------------------------------- server side (the route)
export const notionClient = () => ({ id: process.env.NOTION_CLIENT_ID?.trim() ?? "", secret: process.env.NOTION_CLIENT_SECRET?.trim() ?? "" });
export const notionConfigured = () => Boolean(notionClient().id && notionClient().secret);

export class NotionError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

async function call<T>(token: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": VERSION, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) throw new NotionError("Notion sign-in expired. Connect Notion again.", 401);
  if (res.status === 404) throw new NotionError("Orbit can't see that page. Share it with Orbit in Notion.", 404);
  if (res.status === 429) throw new NotionError("Notion is busy. Try again in a minute.", 429);
  if (!res.ok) throw new NotionError("Couldn't reach Notion. Try again.");
  return (await res.json()) as T;
}

/** OAuth code → access token (needs the client secret, so server only). */
export async function exchangeCode(code: string, redirectUri: string): Promise<{ token: string; workspace: string }> {
  const { id, secret } = notionClient();
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/json", "Notion-Version": VERSION },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; workspace_name?: string };
  if (!res.ok || !j.access_token) throw new NotionError("Notion sign-in failed. Try again.", 400);
  return { token: j.access_token, workspace: j.workspace_name ?? "Notion" };
}

export async function searchPages(token: string, query: string): Promise<NotionPage[]> {
  const out = await call<{ results: RawPage[] }>(token, "/search", {
    query: query.slice(0, 200), page_size: 30, sort: { direction: "descending", timestamp: "last_edited_time" },
  });
  return out.results.map((p) => ({ id: p.id, title: pageTitle(p), url: p.url, edited: p.last_edited_time, icon: p.icon?.emoji ?? null, kind: p.object }));
}

async function children(token: string, id: string, depth: number, budget: { left: number }): Promise<NotionBlock[]> {
  const all: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const page = await call<{ results: NotionBlock[]; has_more: boolean; next_cursor: string | null }>(token, `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    for (const b of page.results) {
      if (budget.left-- <= 0) return all;
      // Subpages are listed by title, not expanded (the student can pick them separately).
      if (b.has_children && depth < NOTION_LIMITS.depth && b.type !== "child_page" && b.type !== "child_database") b.children = await children(token, b.id, depth + 1, budget);
      all.push(b);
    }
    cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
  } while (cursor && budget.left > 0);
  return all;
}

/** A page's content as Markdown; a database becomes a list of its rows' titles. */
export async function pageMarkdown(token: string, id: string, kind: "page" | "database"): Promise<{ title: string; url: string; markdown: string }> {
  if (kind === "database") {
    const db = await call<RawPage>(token, `/databases/${id}`);
    const rows = await call<{ results: RawPage[] }>(token, `/databases/${id}/query`, { page_size: 100 });
    return { title: pageTitle(db), url: db.url, markdown: rows.results.map((r) => `- ${pageTitle(r)}`).join("\n") || "(empty database)" };
  }
  const page = await call<RawPage>(token, `/pages/${id}`);
  const blocks = await children(token, id, 0, { left: NOTION_LIMITS.blocks });
  return { title: pageTitle(page), url: page.url, markdown: blocksToMarkdown(blocks) || "(empty page)" };
}
