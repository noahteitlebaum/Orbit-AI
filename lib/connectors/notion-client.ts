// Browser half of the Notion connector: sign-in pop-up and calls to /api/notion. The token stays in this tab.
import type { NotionPage } from "./notion";
import { ConnectorError } from "./types";

const CLIENT_ID = process.env.NEXT_PUBLIC_NOTION_CLIENT_ID?.trim() ?? "";
export const notionSignInConfigured = Boolean(CLIENT_ID);
const KEY = "orbit.notion";
export const NOTION_CHANNEL = "orbit-notion-auth";

export function notionSession(): { token: string; workspace: string } | null {
  try {
    const v = sessionStorage.getItem(KEY);
    return v ? (JSON.parse(v) as { token: string; workspace: string }) : null;
  } catch {
    return null;
  }
}
export function setNotionSession(v: { token: string; workspace: string } | null) {
  try {
    if (v) sessionStorage.setItem(KEY, JSON.stringify(v));
    else sessionStorage.removeItem(KEY);
  } catch {}
}

async function api<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/notion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    if (res.status === 401) setNotionSession(null);
    throw new ConnectorError(res.status === 503 ? "Notion isn't set up on this server yet." : j.error && j.error.length > 20 ? j.error : "Couldn't reach Notion. Try again.");
  }
  return j;
}

/** Opens Notion's consent screen in a pop-up; resolves once the student has chosen pages and the code is exchanged. */
export function signInToNotion(): Promise<{ token: string; workspace: string }> {
  return new Promise((resolve, reject) => {
    const state = crypto.randomUUID();
    const redirectUri = `${location.origin}/auth/notion`;
    const url = `https://api.notion.com/v1/oauth/authorize?client_id=${encodeURIComponent(CLIENT_ID)}&response_type=code&owner=user&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    const popup = window.open(url, "orbit-notion", "width=520,height=720");
    if (!popup) return reject(new ConnectorError("Allow pop-ups for Orbit to connect Notion."));
    const ch = new BroadcastChannel(NOTION_CHANNEL);
    const timer = setTimeout(() => finish(new ConnectorError("Notion sign-in timed out.")), 5 * 60_000);
    function finish(err: Error | null, v?: { token: string; workspace: string }) {
      clearTimeout(timer);
      ch.close();
      if (err) reject(err);
      else resolve(v!);
    }
    ch.onmessage = (e: MessageEvent<{ code?: string; state?: string; error?: string }>) => {
      if (e.data.state !== state) return;
      if (!e.data.code) return finish(new ConnectorError(e.data.error === "access_denied" ? "Notion access wasn't allowed." : "Notion sign-in failed."));
      api<{ token: string; workspace: string }>({ action: "exchange", code: e.data.code, redirectUri })
        .then((v) => { setNotionSession(v); finish(null, v); })
        .catch((err: Error) => finish(err));
    };
  });
}

export const searchNotion = (token: string, query: string) => api<{ pages: NotionPage[] }>({ action: "search", token, query }).then((r) => r.pages);
export const readNotion = (token: string, pages: { id: string; kind: "page" | "database" }[]) =>
  api<{ pages: { title: string; url: string; markdown: string }[] }>({ action: "read", token, pages }).then((r) => r.pages);
