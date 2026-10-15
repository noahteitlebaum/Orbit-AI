import { json, requireAppUser } from "@/lib/api";
import { deviceConfigured, pollDevice, startDevice } from "@/lib/connectors/github-device";

// POST /api/github/device { action: "start" } → { deviceCode, userCode, verificationUri, interval, expiresIn }
// POST /api/github/device { action: "poll", deviceCode } → { token } | { wait } | { error }
// Relays GitHub's device sign-in for the GitHub connector (lib/connectors/github.ts). Signed-in students only.
export async function POST(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  if (!deviceConfigured()) return json({ error: "not_configured" }, 503);
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; deviceCode?: unknown };
  if (body.action === "start") {
    const out = await startDevice().catch(() => null);
    return out ? json(out) : json({ error: "github_unavailable" }, 502);
  }
  if (body.action === "poll" && typeof body.deviceCode === "string" && /^[\w-]{10,100}$/.test(body.deviceCode)) {
    return json(await pollDevice(body.deviceCode).catch(() => ({ error: "Couldn't reach GitHub." })));
  }
  return json({ error: "bad_request" }, 400);
}
