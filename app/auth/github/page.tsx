"use client";

import { useEffect, useState } from "react";
import { setGithubAuth, type GithubAuth } from "@/lib/connectors/github";
import { GITHUB_CHANNEL, GITHUB_RETURN_KEY, GITHUB_STATE_KEY, githubInstallUrl } from "@/lib/connectors/github-connect";

// GitHub sends the student here after "Authorize" (and after choosing repositories the first time). This page swaps
// the one-time code for a sign-in (through /api/github/oauth), saves it in this browser, tells the Orbit tab, and closes.
let started = false; // a GitHub code works once; React may run effects twice in development

export default function GitHubCallback() {
  const [msg, setMsg] = useState("Connecting GitHub…");
  useEffect(() => {
    if (started) return;
    started = true;
    const q = new URLSearchParams(location.search);
    const code = q.get("code");
    const state = q.get("state") ?? "";
    let expected = "";
    try {
      expected = localStorage.getItem(GITHUB_STATE_KEY) ?? "";
    } catch {}
    const ch = new BroadcastChannel(GITHUB_CHANNEL);
    const finish = (ok: boolean, error?: string) => {
      ch.postMessage({ state: expected, ok, error });
      ch.close();
      try {
        localStorage.removeItem(GITHUB_STATE_KEY);
      } catch {}
      setMsg(ok ? "GitHub connected. You can close this window." : `${error ?? "GitHub wasn't connected."} You can close this window.`);
      let back: string | null = null;
      try {
        back = localStorage.getItem(GITHUB_RETURN_KEY);
        localStorage.removeItem(GITHUB_RETURN_KEY);
      } catch {}
      if (back !== null) location.replace(back || "/"); // pop-ups were blocked: go back to the chat
      else setTimeout(() => window.close(), 300);
    };

    (async () => {
      // Back from "choose repositories" (no new code): already signed in.
      if (!code && q.get("installation_id")) return finish(true);
      if (q.get("error")) return finish(false, q.get("error") === "access_denied" ? "GitHub access wasn't allowed." : "GitHub sign-in failed.");
      if (!code || !expected || state !== expected) return finish(false, "This sign-in link expired. Try Connect again.");
      const res = await fetch("/api/github/oauth", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "exchange", code, redirectUri: `${location.origin}/auth/github` }),
      }).catch(() => null);
      const t = (await res?.json().catch(() => null)) as { token?: string; refreshToken?: string | null; expiresAt?: number | null; error?: string } | null;
      if (!res?.ok || !t?.token) return finish(false, res?.status === 503 ? "GitHub sign-in isn't set up on this server yet." : "GitHub sign-in failed.");
      const headers = { Authorization: `Bearer ${t.token}`, Accept: "application/vnd.github+json" };
      const user = (await fetch("https://api.github.com/user", { headers }).then((r) => r.json()).catch(() => null)) as { login?: string; avatar_url?: string } | null;
      const auth: GithubAuth = { token: t.token, refreshToken: t.refreshToken ?? null, expiresAt: t.expiresAt ?? null, login: user?.login ?? null, avatar: user?.avatar_url ?? null };
      setGithubAuth(auth);
      // First time: Orbit isn't on any repository yet, so GitHub asks which ones (All, or pick some).
      const inst = (await fetch("https://api.github.com/user/installations", { headers }).then((r) => r.json()).catch(() => null)) as { total_count?: number } | null;
      const install = githubInstallUrl(state);
      if (inst && inst.total_count === 0 && install) {
        try {
          localStorage.setItem(GITHUB_STATE_KEY, expected); // keep it for the return trip
        } catch {}
        setMsg("Choose which repositories Orbit can read…");
        location.assign(install);
        return;
      }
      finish(true);
    })();
  }, []);
  return (
    <main className="grid min-h-dvh place-items-center bg-surface-000 p-6 text-center">
      <p className="text-sm text-ink-muted">{msg}</p>
    </main>
  );
}
