// Browser side of Orbit Helper (public/helper/orbit-helper.mjs), which runs on the student's computer at
// 127.0.0.1. The browser talks to it directly: our server on Vercel can't reach the student's machine.

export const HELPER_PORT = 47613;
const BASE = `http://127.0.0.1:${HELPER_PORT}`;
const KEY = "orbit.folder.v1";

export type FolderLink = { token: string; name: string };
/** ask = approve every change; edits = edits/new files/moves run straight away. Deletes always ask. */
export type ApprovalMode = "ask" | "edits";
const MODE_KEY = "orbit.folder.approval.v1";

export function loadApprovalMode(): ApprovalMode {
  try {
    return localStorage.getItem(MODE_KEY) === "edits" ? "edits" : "ask";
  } catch {
    return "ask";
  }
}
export function saveApprovalMode(mode: ApprovalMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {}
}
export type ToolOutcome = { ok: true; output: string } | { ok: false; error: string };

/** Saved pairing (per browser). Storage can be unavailable; then the student pairs again next visit. */
export function loadLink(): FolderLink | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && typeof v.token === "string" && typeof v.name === "string" ? v : null;
  } catch {
    return null;
  }
}
export function saveLink(link: FolderLink | null) {
  try {
    if (link) localStorage.setItem(KEY, JSON.stringify(link));
    else localStorage.removeItem(KEY);
  } catch {}
}

async function call(path: string, init: RequestInit = {}, token?: string, timeoutMs = 30_000): Promise<Response | null> {
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null; // not running, blocked by the browser, or timed out
  }
}

/** running = the helper answered; paired = our saved token works; pairable = the student just opened the helper. */
export async function helperStatus(token?: string): Promise<{ running: boolean; paired: boolean; pairable: boolean; folder?: string; version?: string }> {
  const res = await call("/status", {}, token, 3000);
  if (!res?.ok) return { running: false, paired: false, pairable: false };
  const body = (await res.json().catch(() => ({}))) as { paired?: boolean; pairable?: boolean; folder?: string; version?: string };
  return { running: true, paired: Boolean(body.paired), pairable: Boolean(body.pairable), folder: body.folder, version: body.version };
}

/** Connect to a helper the student has just opened (it accepts one connection for 10 minutes after opening). */
export async function pairHelper(): Promise<FolderLink | null> {
  const res = await call("/pair", { method: "POST" }, undefined, 5000);
  if (!res?.ok) return null;
  const body = (await res.json()) as { token: string; folder: string };
  return { token: body.token, name: body.folder };
}

/** Opens the folder picker on the student's computer. Returns the new folder name, or null if they cancelled. */
export async function chooseFolder(token: string): Promise<string | null> {
  const res = await call("/choose-folder", { method: "POST" }, token, 10 * 60_000);
  const body = (await res?.json().catch(() => null)) as { ok?: boolean; folder?: string } | null;
  return body?.ok && body.folder ? body.folder : null;
}

export async function forgetHelper(token: string) {
  await call("/disconnect", { method: "POST" }, token, 3000);
}

/** Run one folder tool. dryRun checks a change (and describes it) without making it. */
export async function runFolderTool(token: string, name: string, args: Record<string, unknown>, dryRun = false): Promise<ToolOutcome> {
  const res = await call("/tool", { method: "POST", body: JSON.stringify({ name, args, dryRun }) }, token, 60_000);
  if (!res) return { ok: false, error: "Orbit Helper isn't reachable. It may have been closed." };
  if (res.status === 401) return { ok: false, error: "Orbit Helper needs connecting again (open the Orbit Helper app)." };
  const body = (await res.json().catch(() => null)) as ToolOutcome | null;
  return body ?? { ok: false, error: "Orbit Helper gave an unreadable answer." };
}
