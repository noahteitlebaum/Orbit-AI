"use client";

import { useState } from "react";
import { GitHubError } from "@/lib/connectors/github";
import { connectGitHub, githubConnectReadyNow } from "@/lib/connectors/github-connect";
import { ConnectorError } from "@/lib/connectors/types";
import { connectZotero } from "@/lib/connectors/zotero";
import type { PluginInfo } from "@/lib/plugins/catalog";
import { connectPopup } from "@/lib/plugins/connect";

// The sign-in step for one plugin: one Connect button that opens the app's own sign-in page (GitHub, Google,
// Microsoft, Notion), or a pasted key for Zotero.
// Used on the Plugins page and inline in a chat when the AI needs an app that isn't connected yet.
export function PluginConnect({ plugin, onConnected, compact = false, label }: { plugin: PluginInfo; onConnected: () => void; compact?: boolean; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState("");

  const btn = compact
    ? "rounded-full bg-brand px-3.5 py-1.5 text-sm font-medium text-on-brand disabled:opacity-50"
    : "rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-on-brand disabled:opacity-50";

  async function popup() {
    setBusy(true);
    setError(null);
    try {
      await connectPopup(plugin);
      onConnected();
    } catch (e) {
      setError(e instanceof ConnectorError ? e.message : `Couldn't connect ${plugin.name}. Try again.`);
    } finally {
      setBusy(false);
    }
  }

  async function github() {
    setBusy(true);
    setError(null);
    try {
      await connectGitHub();
      onConnected();
    } catch (e) {
      setError(e instanceof GitHubError ? e.message : "GitHub sign-in failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function zotero() {
    setBusy(true);
    setError(null);
    try {
      await connectZotero(key);
      onConnected();
    } catch (e) {
      setError(e instanceof ConnectorError ? e.message : "Couldn't check that key.");
    } finally {
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  if (plugin.auth === "github" && !githubConnectReadyNow()) {
    body = <p className="text-sm text-ink-muted">Public repositories already work. Signing in to GitHub isn&apos;t set up on this server yet.</p>;
  } else if (plugin.auth === "github") {
    body = <button type="button" onClick={github} disabled={busy} className={btn}>{busy ? "Waiting for GitHub…" : label ?? "Connect GitHub"}</button>;
  } else if (plugin.auth === "zotero") {
    body = (
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void zotero(); }}>
        {!compact && (
          <p className="text-sm text-ink-muted">
            Make a key at <a href="https://www.zotero.org/settings/keys/new" target="_blank" rel="noreferrer" className="font-medium text-ink underline underline-offset-[3px]">zotero.org/settings/keys/new</a> with
            only <b>Allow library access</b> ticked, then paste it here. It stays in this browser.
          </p>
        )}
        <div className="flex gap-2">
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Zotero API key" aria-label="Zotero API key" autoComplete="off" spellCheck={false}
            className="min-w-0 flex-1 rounded-xl border border-line-strong bg-surface-000 px-3.5 py-2 font-mono text-sm outline-none focus:border-brand" />
          <button type="submit" disabled={busy || !key.trim()} className={btn}>{busy ? "Checking…" : "Connect"}</button>
        </div>
      </form>
    );
  } else if (plugin.auth === "none") {
    body = null;
  } else {
    body = <button type="button" onClick={popup} disabled={busy} className={btn}>{busy ? "Waiting for sign-in…" : label ?? `Connect ${plugin.name}`}</button>;
  }
  return (
    <div>
      {body}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
