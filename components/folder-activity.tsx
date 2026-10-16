"use client";

import { useState } from "react";
import type { RunOutput, RunResult } from "@/lib/code/runner";
import { PLUGIN_BY_ID, pluginOfTool, type PluginId, type PluginLink } from "@/lib/plugins/catalog";
import { AppLogo } from "./app-logos";
import { PluginConnect } from "./plugin-connect";

// Tool actions taken while writing a reply: file actions (changes wait here for the student's Apply / Skip)
// and Python runs (code, output, charts and downloads).
export type ActivityStatus = "running" | "waiting" | "connect" | "ok" | "declined" | "error";
export type Activity = {
  id: string;
  name: string;
  label: string;
  status: ActivityStatus;
  detail?: string; // what a change will do (from the helper's dry run), or why it failed
  preview?: { old?: string; next?: string };
  code?: string;         // run_python: the program
  stdout?: string;       // run_python: what it printed
  outputs?: RunOutput[]; // run_python: files it saved (only while the page is open)
  connect?: PluginId;    // a plugin the AI needs that isn't connected yet (status "connect")
  links?: PluginLink[];  // pages a plugin read (shown as Sources under the answer)
};

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)}\n…` : s);

export function previewFor(name: string, args: Record<string, unknown>): Activity["preview"] {
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  if (name === "edit_file") return { old: clip(s("old_text"), 1500), next: clip(s("new_text"), 1500) };
  if (name === "write_file") return { next: clip(s("content"), 2500) };
  return undefined;
}

const STATUS_TEXT: Record<ActivityStatus, string> = { running: "Working…", waiting: "Needs your OK", connect: "Needs sign-in", ok: "Done", declined: "Skipped", error: "Failed" };

const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export type RerunPython = (code: string) => Promise<RunResult>;

function PythonRun({ a, onRun }: { a: Activity; onRun?: RerunPython }) {
  // The student can edit the code and run it again here; the new run replaces what's shown (the AI isn't asked again).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.code ?? "");
  const [running, setRunning] = useState(false);
  const [mine, setMine] = useState<{ code: string; r: RunResult } | null>(null);
  const status = running ? "running" : mine ? (mine.r.ok ? "ok" : "error") : a.status;
  const code = mine?.code ?? a.code;
  const stdout = mine ? [mine.r.stdout, mine.r.stderr].filter((x) => x.trim()).join("\n").trim() : a.stdout;
  const error = mine ? mine.r.error : a.detail;
  const outputs = mine ? mine.r.files : a.outputs;
  const images = (outputs ?? []).filter((f) => f.mime.startsWith("image/"));

  async function run() {
    if (!onRun || running) return;
    setRunning(true);
    const r = await onRun(draft);
    setMine({ code: draft, r });
    setRunning(false);
    setEditing(false);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      run();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const t = e.currentTarget;
      const { selectionStart: s0, selectionEnd: s1 } = t;
      const next = draft.slice(0, s0) + "    " + draft.slice(s1);
      setDraft(next);
      requestAnimationFrame(() => t.setSelectionRange(s0 + 4, s0 + 4));
    }
  }

  const btn = "rounded-full border border-line-strong px-3 py-1 font-medium text-ink hover:bg-surface-300 disabled:opacity-60";
  return (
    <li className="rounded-2xl border border-line bg-surface-100 p-3 text-xs">
      <div className="flex items-center gap-2 text-ink-muted">
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${status === "ok" ? "bg-success" : status === "error" ? "bg-danger" : "animate-pulse bg-ice"}`} />
        <span className="font-medium text-ink">{status === "running" ? "Running Python…" : status === "ok" ? "Ran Python" : "Python run failed"}</span>
        {mine && !running && <span className="text-ink-subtle">· your edit</span>}
        {onRun && code !== undefined && !editing && a.status !== "running" && (
          <button type="button" onClick={() => { setDraft(code); setEditing(true); }} className={`${btn} ml-auto`}>Edit &amp; run</button>
        )}
      </div>
      {editing ? (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            spellCheck={false}
            aria-label="Python code"
            rows={Math.min(24, Math.max(6, draft.split("\n").length + 1))}
            className="w-full resize-y rounded-xl border border-line bg-surface-000 px-3 py-2 font-mono text-xs text-ink outline-none focus:border-brand"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button type="button" onClick={run} disabled={running || !draft.trim()} className="rounded-full bg-brand px-3 py-1 font-medium text-on-brand disabled:opacity-60">{running ? "Running…" : "Run"}</button>
            <button type="button" onClick={() => setEditing(false)} disabled={running} className={btn}>Cancel</button>
            <span className="text-ink-subtle">Ctrl+Enter to run</span>
          </div>
        </div>
      ) : (
        code && (
          <details className="mt-2">
            <summary className="cursor-pointer text-ink-subtle">Code</summary>
            <pre className="mt-1.5 max-h-72 overflow-auto rounded-xl bg-surface-000 px-3 py-2 font-mono">{code}</pre>
          </details>
        )
      )}
      {stdout && (
        <details className="mt-1.5" open={status !== "running"}>
          <summary className="cursor-pointer text-ink-subtle">Output</summary>
          <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-surface-000 px-3 py-2 font-mono">{stdout}</pre>
        </details>
      )}
      {status === "error" && error && <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-xl bg-danger-surface px-3 py-2 font-mono text-danger">{error}</pre>}
      {images.map((f) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={f.url} src={f.url} alt={f.name} className="mt-2 max-h-96 w-auto rounded-xl border border-line bg-white" />
      ))}
      {outputs && outputs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {outputs.map((f) => (
            <a key={f.url} href={f.url} download={f.name} className={btn}>
              ↓ {f.name} <span className="text-ink-subtle">({fmtSize(f.size)})</span>
            </a>
          ))}
        </div>
      )}
    </li>
  );
}

/** "Used GitHub and Gmail · 3 steps" — the quiet steps folded into one line, like the apps show tool use. */
function StepsSummary({ items }: { items: Activity[] }) {
  const running = items.some((a) => a.status === "running");
  const failed = items.filter((a) => a.status === "error").length;
  const [open, setOpen] = useState(false);
  const apps = [...new Set(items.map((a) => pluginOfTool(a.name)).filter((x): x is PluginId => Boolean(x)))];
  const names = apps.map((id) => PLUGIN_BY_ID.get(id)!.name);
  const usedFolder = items.some((a) => !pluginOfTool(a.name));
  const who = [...names, ...(usedFolder ? ["your folder"] : [])];
  const list = who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who.at(-1)}` : who[0] ?? "tools";
  const shown = open || running;
  return (
    <li>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={shown}
        className="flex items-center gap-2 rounded-full py-0.5 text-sm text-ink-muted transition hover:text-ink">
        <span className="flex -space-x-1">{apps.slice(0, 3).map((id) => <span key={id} className="rounded-[5px] ring-2 ring-surface-000"><AppLogo id={id} size={18} /></span>)}</span>
        <span className={running ? "orbit-shimmer" : ""}>{running ? `Working with ${list}…` : `Used ${list}`}</span>
        <span className="text-ink-subtle">· {items.length} step{items.length === 1 ? "" : "s"}{failed ? ` · ${failed} failed` : ""}</span>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden className={`transition-transform ${shown ? "rotate-90" : ""}`}><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {shown && (
        <ul className="ml-1.5 mt-1.5 space-y-1 border-l border-line pl-3">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-xs text-ink-muted">
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${a.status === "ok" ? "bg-success" : a.status === "error" ? "bg-danger" : a.status === "running" ? "animate-pulse bg-ice" : "bg-ink-subtle"}`} />
              <span className="min-w-0 truncate">{a.label.replace(/^[^·]+·\s*/, "")}</span>
              <span className="shrink-0 text-ink-subtle">· {STATUS_TEXT[a.status]}</span>
              {a.status === "error" && a.detail && <span className="min-w-0 truncate text-danger" title={a.detail}>— {a.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function FolderActivity({ items, onDecide, onRun }: { items: Activity[]; onDecide: (id: string, approve: boolean) => void; onRun?: RerunPython }) {
  const quiet = items.filter((a) => a.name !== "run_python" && a.status !== "waiting" && a.status !== "connect");
  const rest = items.filter((a) => !quiet.includes(a));
  return (
    <ul className="mb-3 space-y-1.5" aria-label="Tool actions">
      {quiet.length > 0 && <StepsSummary items={quiet} />}
      {rest.map((a) =>
        a.name === "run_python" ? (
          <PythonRun key={a.id} a={a} onRun={onRun} />
        ) : a.status === "connect" && a.connect ? (
          <li key={a.id} className="rounded-2xl border border-line-strong bg-surface-100 p-3">
            <div className="flex items-center gap-2.5">
              <AppLogo id={a.connect} size={28} framed />
              <p className="min-w-0 flex-1 text-sm"><span className="font-medium">Connect {PLUGIN_BY_ID.get(a.connect)?.name}</span> to let the AI continue ({a.label.replace(/^[^·]+·\s*/, "").toLowerCase()}).</p>
            </div>
            <div className="mt-3 flex flex-wrap items-start gap-2">
              <PluginConnect compact plugin={PLUGIN_BY_ID.get(a.connect)!} onConnected={() => onDecide(a.id, true)} />
              <button type="button" onClick={() => onDecide(a.id, false)} className="rounded-full border border-line-strong px-3.5 py-1.5 text-sm font-medium hover:bg-surface-300">Not now</button>
            </div>
          </li>
        ) : a.status === "waiting" ? (
          <li key={a.id} className="rounded-2xl border border-line-strong bg-surface-100 p-3">
            <p className="text-sm font-medium">{a.label}</p>
            {a.detail && <p className="mt-0.5 text-xs text-ink-muted">{a.detail}</p>}
            {a.preview?.old !== undefined && (
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-danger-surface px-3 py-2 text-xs text-danger"><span className="sr-only">Remove: </span>{a.preview.old}</pre>
            )}
            {a.preview?.next !== undefined && (
              <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-xl bg-surface-000 px-3 py-2 text-xs"><span className="sr-only">New text: </span>{a.preview.next || "(empty)"}</pre>
            )}
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => onDecide(a.id, true)} className="rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-on-brand">Apply</button>
              <button type="button" onClick={() => onDecide(a.id, false)} className="rounded-full border border-line-strong px-4 py-1.5 text-sm font-medium hover:bg-surface-300">Skip</button>
            </div>
          </li>
        ) : (
          <li key={a.id} className="flex items-center gap-2 text-xs text-ink-muted">
            {pluginOfTool(a.name) ? (
              <span className={a.status === "running" ? "animate-pulse" : ""}><AppLogo id={pluginOfTool(a.name)!} size={16} /></span>
            ) : (
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${a.status === "ok" ? "bg-success" : a.status === "error" ? "bg-danger" : a.status === "running" ? "animate-pulse bg-ice" : "bg-ink-subtle"}`} />
            )}
            <span className="min-w-0 truncate">{a.label}</span>
            <span className="shrink-0 text-ink-subtle">· {STATUS_TEXT[a.status]}</span>
            {a.status === "error" && a.detail && <span className="min-w-0 truncate text-danger" title={a.detail}>— {a.detail}</span>}
          </li>
        ),
      )}
    </ul>
  );
}

/** "Sources" under an answer: the pages, papers, files and issues the AI's plugins opened (like the apps' source pills). */
export function PluginSources({ items }: { items: Activity[] }) {
  const seen = new Set<string>();
  const links = items.flatMap((a) => (a.links ?? []).map((l) => ({ ...l, app: pluginOfTool(a.name) })))
    .filter((l) => !seen.has(l.url) && seen.add(l.url)).slice(0, 10);
  if (!links.length) return null;
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-xs font-medium text-ink-subtle">Sources</p>
      <div className="flex flex-wrap gap-1.5">
        {links.map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noreferrer" title={l.url}
            className="flex max-w-[18rem] items-center gap-1.5 rounded-full border border-line bg-surface-100 py-1 pl-1.5 pr-3 text-xs text-ink-muted transition hover:bg-surface-200 hover:text-ink">
            {l.app && <AppLogo id={l.app} size={16} />}
            <span className="truncate">{l.title}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
