// Server side of "Connect GitHub" (GitHub's normal sign-in page: "Orbit AI wants access to your GitHub account" →
// Authorize). Swaps the one-time code for a token using the app's client secret, which never leaves the server.
// Nothing is stored here; the token goes straight back to the student's browser.
const CLIENT_ID = () => process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID?.trim() ?? "";
const SECRET = () => process.env.GITHUB_CLIENT_SECRET?.trim() ?? "";

export const oauthConfigured = () => Boolean(CLIENT_ID() && SECRET());

export type GithubTokens = { token: string; refreshToken: string | null; expiresAt: number | null };

async function tokenCall(params: Record<string, string>): Promise<GithubTokens> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID(), client_secret: SECRET(), ...params }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!j.access_token) throw new Error(j.error ?? `status_${res.status}`);
  return {
    token: j.access_token,
    refreshToken: j.refresh_token ?? null,
    // GitHub Apps can expire user tokens (8 h) and give a refresh token; otherwise the token lasts until revoked.
    expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : null,
  };
}

export const exchangeCode = (code: string, redirectUri: string) => tokenCall({ code, redirect_uri: redirectUri });
export const refreshToken = (refresh: string) => tokenCall({ grant_type: "refresh_token", refresh_token: refresh });
