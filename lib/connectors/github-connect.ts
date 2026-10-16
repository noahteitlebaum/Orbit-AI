// Browser: "Connect GitHub" — opens GitHub's own sign-in page in a pop-up ("Orbit AI wants access to your GitHub
// account" → Authorize). The first time, GitHub then asks which repositories Orbit may read. The pop-up
// (/auth/github) saves the sign-in in this browser and tells this tab; nothing else for the student to do.
import { GITHUB_APP_SLUG, GITHUB_CLIENT_ID, githubAuth, GitHubError } from "./github";

export const GITHUB_CHANNEL = "orbit-github-auth";
export const GITHUB_STATE_KEY = "orbit.github.state";
export const GITHUB_RETURN_KEY = "orbit.github.return";

export function githubAuthorizeUrl(state: string): string {
  const redirect = `${location.origin}/auth/github`;
  return `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(GITHUB_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`;
}
export const githubInstallUrl = (state?: string) => (GITHUB_APP_SLUG ? `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new${state ? `?state=${state}` : ""}` : "");

let ready: Promise<boolean> | null = null;
let readyNow = false;
/** Whether the server has the GitHub client secret (needed for the sign-in page). */
export function githubConnectReady(): Promise<boolean> {
  ready ??= fetch("/api/github/oauth").then((r) => (r.ok ? r.json() : { ready: false })).then((j: { ready?: boolean }) => (readyNow = Boolean(j.ready))).catch(() => false);
  return ready;
}
/** Same, without waiting (after githubConnectReady() has been called once) — so a click can open the pop-up directly. */
export const githubConnectReadyNow = () => readyNow;

/** Opens GitHub's sign-in and resolves with the GitHub username once the student has authorized Orbit. */
export function connectGitHub(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (!GITHUB_CLIENT_ID) return reject(new GitHubError("GitHub sign-in isn't set up on this server yet."));
    const state = crypto.randomUUID();
    try {
      localStorage.setItem(GITHUB_STATE_KEY, state);
    } catch {}
    const url = githubAuthorizeUrl(state);
    const w = 620, h = 760;
    const popup = window.open(url, "orbit-github", `width=${w},height=${h},left=${Math.max(0, (screen.width - w) / 2)},top=${Math.max(0, (screen.height - h) / 3)}`);
    if (!popup) {
      // Pop-ups blocked: do it in this tab and come back here afterwards.
      try {
        localStorage.setItem(GITHUB_RETURN_KEY, location.pathname + location.search);
      } catch {}
      location.assign(url);
      return;
    }
    const ch = new BroadcastChannel(GITHUB_CHANNEL);
    const timer = setTimeout(() => done(new GitHubError("GitHub sign-in timed out. Try again.")), 10 * 60_000);
    // The pop-up saves the sign-in in this browser as soon as GitHub says yes (before the repository picker).
    const onStorage = (e: StorageEvent) => {
      if (e.key === "orbit.github.auth" && e.newValue) done(null);
    };
    window.addEventListener("storage", onStorage);
    let settled = false;
    function done(err: Error | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("storage", onStorage);
      ch.close();
      if (err) reject(err);
      else resolve(githubAuth()?.login ?? null);
    }
    ch.onmessage = (e: MessageEvent<{ state?: string; ok?: boolean; error?: string }>) => {
      if (e.data.state !== state) return;
      done(e.data.ok ? null : new GitHubError(e.data.error ?? "GitHub sign-in didn't finish."));
    };
  });
}
