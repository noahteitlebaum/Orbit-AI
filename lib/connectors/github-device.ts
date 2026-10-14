// Server side of "Sign in with GitHub" (device flow). Holds no secrets and stores nothing: it only relays the two
// GitHub sign-in calls that browsers aren't allowed to make directly. The token goes straight back to the student's tab.
const CLIENT_ID = () => process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID?.trim() ?? "";
// GitHub Apps ignore scopes (permissions are set on the app). For a classic OAuth App set GITHUB_OAUTH_SCOPE (e.g. "repo").
const SCOPE = () => process.env.GITHUB_OAUTH_SCOPE?.trim() ?? "";

export function deviceConfigured() {
  return Boolean(CLIENT_ID());
}

async function post(url: string, body: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export async function startDevice() {
  const { status, json } = await post("https://github.com/login/device/code", { client_id: CLIENT_ID(), ...(SCOPE() ? { scope: SCOPE() } : {}) });
  if (status !== 200 || typeof json.device_code !== "string") return null;
  return { deviceCode: json.device_code, userCode: String(json.user_code), verificationUri: String(json.verification_uri ?? "https://github.com/login/device"), interval: Number(json.interval ?? 5), expiresIn: Number(json.expires_in ?? 900) };
}

/** One poll. Maps GitHub's answers to { token } | { wait } | { error }. */
export async function pollDevice(deviceCode: string): Promise<{ token?: string; wait?: number; error?: string }> {
  const { json } = await post("https://github.com/login/oauth/access_token", { client_id: CLIENT_ID(), device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  if (typeof json.access_token === "string") return { token: json.access_token };
  switch (json.error) {
    case "authorization_pending": return { wait: 0 };
    case "slow_down": return { wait: Number(json.interval ?? 10) };
    case "expired_token": return { error: "The code expired. Start again." };
    case "access_denied": return { error: "Sign-in was cancelled on GitHub." };
    default: return { error: "GitHub sign-in failed. Start again." };
  }
}
