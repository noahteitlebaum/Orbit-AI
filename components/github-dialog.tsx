"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  bundleRepo, fileText, GITHUB_APP_SLUG, GITHUB_LIMITS, GitHubError, githubSignInConfigured, githubToken, isTextPath, loadRepo, myRepos,
  parseRepoUrl, pollDeviceSignIn, setGithubToken, startDeviceSignIn, suggestFiles, type MyRepo, type RepoInfo,
} from "@/lib/connectors/github";

// Pick a GitHub repository and files to bring into the chat (one bundled, searchable file).
type Device = { userCode: string; verificationUri: string };

export function GitHubDialog({ open, onClose, onPicked }: { open: boolean; onClose: () => void; onPicked: (files: File[]) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [repos, setRepos] = useState<MyRepo[] | null>(null);
  const [repoFilter, setRepoFilter] = useState("");
  const [device, setDevice] = useState<Device | null>(null);
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [fileFilter, setFileFilter] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelPoll = useRef(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setInfo(null);
      setStatus(null);
      setDevice(null);
      const t = githubToken();
      setToken(t);
      if (t) myRepos(t).then(setRepos).catch(() => setRepos(null));
    } else if (!open && d.open) {
      cancelPoll.current = true;
      d.close();
    }
  }, [open]);

  async function load(input: string) {
    const parsed = parseRepoUrl(input);
    if (!parsed) return setStatus("Paste a GitHub repository link, like github.com/owner/repo.");
    setBusy(true);
    setStatus("Loading the repository…");
    try {
      const r = await loadRepo(parsed, token);
      setInfo(r);
      setPicked(new Set(suggestFiles(r.tree, parsed.path)));
      setFileFilter(parsed.path ?? "");
      setStatus(r.truncated ? "This repository is very large; GitHub only listed part of it." : null);
    } catch (e) {
      setStatus(e instanceof GitHubError ? e.message : "Couldn't load that repository.");
    } finally {
      setBusy(false);
    }
  }

  async function signIn() {
    setStatus(null);
    cancelPoll.current = false;
    try {
      const d = await startDeviceSignIn();
      setDevice({ userCode: d.userCode, verificationUri: d.verificationUri });
      let wait = d.interval;
      const until = Date.now() + d.expiresIn * 1000;
      while (!cancelPoll.current && Date.now() < until) {
        await new Promise((r) => setTimeout(r, wait * 1000));
        const out = await pollDeviceSignIn(d.deviceCode);
        if (out.token) {
          setGithubToken(out.token);
          setToken(out.token);
          setDevice(null);
          setStatus("Signed in to GitHub.");
          setRepos(await myRepos(out.token).catch(() => []));
          return;
        }
        if (out.error) throw new GitHubError(out.error);
        if (out.wait) wait = out.wait;
      }
      setDevice(null);
    } catch (e) {
      setDevice(null);
      setStatus(e instanceof GitHubError ? e.message : "GitHub sign-in failed.");
    }
  }

  function signOut() {
    setGithubToken(null);
    setToken(null);
    setRepos(null);
  }

  const textFiles = useMemo(() => (info ? info.tree.filter((f) => isTextPath(f.path)) : []), [info]);
  const shown = useMemo(() => {
    const q = fileFilter.trim().toLowerCase();
    return (q ? textFiles.filter((f) => f.path.toLowerCase().includes(q)) : textFiles).slice(0, 500);
  }, [textFiles, fileFilter]);
  const pickedBytes = useMemo(() => textFiles.filter((f) => picked.has(f.path)).reduce((n, f) => n + Math.min(f.size, GITHUB_LIMITS.fileBytes), 0), [textFiles, picked]);

  function toggle(path: string) {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else if (next.size < GITHUB_LIMITS.files) next.add(path);
      return next;
    });
  }

  async function add() {
    if (!info) return;
    setBusy(true);
    try {
      const files: { path: string; content: string }[] = [];
      const paths = [...picked].sort();
      for (const [i, path] of paths.entries()) {
        setStatus(`Downloading ${i + 1} of ${paths.length}: ${path}`);
        try {
          files.push({ path, content: await fileText(info, path, token) });
        } catch {
          // skip unreadable files; the bundle lists what was included
        }
      }
      const md = bundleRepo(info, files);
      onPicked([new File([md], `${info.owner}-${info.repo}@${info.commit.slice(0, 7)}.md`, { type: "text/markdown" })]);
      onClose();
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  const kb = (n: number) => `${Math.max(1, Math.round(n / 1000))} KB`;
  const repoList = (repos ?? []).filter((r) => !repoFilter || r.fullName.toLowerCase().includes(repoFilter.toLowerCase())).slice(0, 50);
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto h-[min(88dvh,680px)] w-[min(94vw,600px)] rounded-3xl border border-line bg-composer p-0 text-ink shadow-menu backdrop:bg-black/50">
      <div className="flex h-full flex-col p-5">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-medium">{info ? `${info.owner}/${info.repo}` : "Add from GitHub"}</h2>
          {info && <span className="truncate text-xs text-ink-subtle">{info.ref} · {info.commit.slice(0, 7)}{info.private ? " · private" : ""}</span>}
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded-full px-2.5 py-1 text-ink-muted hover:bg-surface-300">✕</button>
        </div>

        {!info ? (
          <div className="mt-3 flex min-h-0 flex-1 flex-col">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void load(url); }}>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="github.com/owner/repo" aria-label="GitHub repository link"
                className="min-w-0 flex-1 rounded-xl border border-line-strong bg-surface-000 px-3.5 py-2 text-sm outline-none focus:border-brand" />
              <button type="submit" disabled={busy || !url.trim()} className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-on-brand disabled:opacity-50">Open</button>
            </form>
            <p className="mt-2 text-xs text-ink-subtle">Public repositories work without signing in. Orbit only reads files you choose.</p>

            {githubSignInConfigured && (
              <div className="mt-4 rounded-2xl border border-line p-4">
                {token ? (
                  <>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">Your repositories</p>
                      <button type="button" onClick={signOut} className="ml-auto text-xs text-ink-subtle underline underline-offset-[3px] hover:text-ink">Sign out</button>
                    </div>
                    <input value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} placeholder="Filter" aria-label="Filter repositories"
                      className="mt-2 w-full rounded-xl border border-line bg-surface-000 px-3 py-1.5 text-sm outline-none focus:border-brand" />
                    <ul className="mt-2 max-h-56 overflow-y-auto">
                      {repos === null && <li className="py-2 text-sm text-ink-subtle">Loading…</li>}
                      {repos?.length === 0 && <li className="py-2 text-sm text-ink-subtle">No repositories yet.{GITHUB_APP_SLUG ? " Install the Orbit app on the ones you want." : ""}</li>}
                      {repoList.map((r) => (
                        <li key={r.fullName}>
                          <button type="button" onClick={() => void load(r.fullName)} disabled={busy}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-200">
                            <span className="min-w-0 flex-1 truncate">{r.fullName}</span>
                            {r.private && <span className="rounded-full bg-surface-300 px-2 text-[10px] text-ink-muted">private</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {GITHUB_APP_SLUG && (
                      <a href={`https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-ink-subtle underline underline-offset-[3px] hover:text-ink">
                        Give Orbit access to more repositories
                      </a>
                    )}
                  </>
                ) : device ? (
                  <div className="text-sm">
                    <p>1. Open <a href={device.verificationUri} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-[3px]">{device.verificationUri.replace(/^https:\/\//, "")}</a></p>
                    <p className="mt-1.5 flex items-center gap-2">2. Enter <code className="rounded-lg bg-surface-200 px-2 py-1 font-mono text-base tracking-widest">{device.userCode}</code>
                      <button type="button" onClick={() => navigator.clipboard?.writeText(device.userCode)} className="text-xs underline underline-offset-[3px]">Copy</button></p>
                    <p className="mt-2 text-xs text-ink-subtle">Waiting for GitHub… this updates by itself.</p>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <p className="min-w-0 flex-1 text-sm text-ink-muted">Private repositories need you to sign in. Orbit can only read code (never change it).</p>
                    <button type="button" onClick={signIn} className="shrink-0 rounded-full border border-line-strong px-4 py-2 text-sm font-medium hover:bg-surface-300">Sign in with GitHub</button>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-3 flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2">
              <input value={fileFilter} onChange={(e) => setFileFilter(e.target.value)} placeholder="Filter files (e.g. src/ or .py)" aria-label="Filter files"
                className="min-w-0 flex-1 rounded-xl border border-line-strong bg-surface-000 px-3.5 py-2 text-sm outline-none focus:border-brand" />
              <button type="button" onClick={() => setPicked(new Set(suggestFiles(info.tree)))} className="rounded-full border border-line px-3 py-1.5 text-xs hover:bg-surface-300">Suggested</button>
              <button type="button" onClick={() => setPicked(new Set())} className="rounded-full border border-line px-3 py-1.5 text-xs hover:bg-surface-300">Clear</button>
            </div>
            <ul className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line" aria-label="Repository files">
              {shown.map((f) => (
                <li key={f.path} className="border-b border-line last:border-0">
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-1.5 text-sm hover:bg-surface-200">
                    <input type="checkbox" checked={picked.has(f.path)} onChange={() => toggle(f.path)} className="h-4 w-4 shrink-0 accent-[var(--brand)]" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path}</span>
                    <span className="shrink-0 text-xs text-ink-subtle">{kb(f.size)}</span>
                  </label>
                </li>
              ))}
              {shown.length === 0 && <li className="p-4 text-sm text-ink-subtle">No readable files match.</li>}
            </ul>
            <div className="mt-3 flex items-center gap-2">
              <button type="button" onClick={() => setInfo(null)} disabled={busy} className="text-sm text-ink-muted underline underline-offset-[3px]">Back</button>
              <p className="ml-auto text-xs text-ink-subtle">{picked.size} file{picked.size === 1 ? "" : "s"} · ~{kb(pickedBytes)} of {GITHUB_LIMITS.bundleBytes / 1000} KB</p>
              <button type="button" onClick={add} disabled={!picked.size || busy}
                className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-on-brand disabled:opacity-50">{busy ? "Adding…" : "Add to chat"}</button>
            </div>
          </div>
        )}
        {status && <p role="status" className="mt-2 text-sm text-ink-muted">{status}</p>}
      </div>
    </dialog>
  );
}
