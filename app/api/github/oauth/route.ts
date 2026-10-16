import { json, requireAppUser } from "@/lib/api";
import { exchangeCode, oauthConfigured, refreshToken } from "@/lib/connectors/github-oauth";

// POST /api/github/oauth { action: "exchange", code, redirectUri } | { action: "refresh", refreshToken }
//   → { token, refreshToken, expiresAt } | { error }
// GET  /api/github/oauth → { ready } (whether Connect GitHub is set up on this server)
// Signed-in students only. Nothing is stored.
export async function GET() {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  return json({ ready: oauthConfigured() });
}

export async function POST(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  if (!oauthConfigured()) return json({ error: "not_configured" }, 503);
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; code?: unknown; redirectUri?: unknown; refreshToken?: unknown };
  try {
    if (body.action === "exchange" && typeof body.code === "string" && /^[\w-]{4,100}$/.test(body.code) && typeof body.redirectUri === "string") {
      // Must be our own callback page (GitHub also checks it against the app's Callback URL).
      const r = (() => { try { return new URL(body.redirectUri as string); } catch { return null; } })();
      const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
      if (!r || r.pathname !== "/auth/github" || r.host !== host) return json({ error: "bad_request" }, 400);
      return json(await exchangeCode(body.code, body.redirectUri));
    }
    if (body.action === "refresh" && typeof body.refreshToken === "string" && body.refreshToken.length < 400) {
      return json(await refreshToken(body.refreshToken));
    }
    return json({ error: "bad_request" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || "github_failed") }, 400);
  }
}
