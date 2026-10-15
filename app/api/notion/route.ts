import { json, requireAppUser } from "@/lib/api";
import { exchangeCode, notionConfigured, NotionError, NOTION_LIMITS, pageMarkdown, searchPages } from "@/lib/connectors/notion";

// POST /api/notion — relays read-only Notion calls for the Notion connector (lib/connectors/notion.ts).
//   { action: "exchange", code, redirectUri } → { token, workspace }
//   { action: "search", token, query }        → { pages }
//   { action: "read", token, pages: [{ id, kind }] } → { pages: [{ title, url, markdown }] }
// The student's token travels with each request and is never stored or logged. Signed-in students only.
const ID = /^[0-9a-f-]{32,36}$/i;

export async function POST(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  if (!notionConfigured()) return json({ error: "not_configured" }, 503);
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; code?: unknown; redirectUri?: unknown; token?: unknown; query?: unknown; pages?: unknown };
  try {
    if (body.action === "exchange" && typeof body.code === "string" && typeof body.redirectUri === "string") {
      const origin = new URL(request.url).origin;
      if (!body.redirectUri.startsWith(`${origin}/`)) return json({ error: "bad_request" }, 400);
      return json(await exchangeCode(body.code, body.redirectUri));
    }
    if (typeof body.token !== "string" || body.token.length > 300) return json({ error: "bad_request" }, 400);
    if (body.action === "search") return json({ pages: await searchPages(body.token, typeof body.query === "string" ? body.query : "") });
    if (body.action === "read" && Array.isArray(body.pages)) {
      const list = (body.pages as { id?: unknown; kind?: unknown }[]).slice(0, NOTION_LIMITS.pick)
        .filter((p): p is { id: string; kind: "page" | "database" } => typeof p.id === "string" && ID.test(p.id) && (p.kind === "page" || p.kind === "database"));
      const pages = [];
      for (const p of list) pages.push(await pageMarkdown(body.token, p.id, p.kind));
      return json({ pages });
    }
    return json({ error: "bad_request" }, 400);
  } catch (e) {
    return e instanceof NotionError ? json({ error: e.message }, e.status) : json({ error: "Couldn't reach Notion. Try again." }, 502);
  }
}
