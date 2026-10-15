"use client";

import { useRef, useState } from "react";
import { PROVIDERS, type ProviderId } from "@/config/models";
import { THEMES } from "@/config/themes";
import { importBatches, readExportFile, type ParsedExport } from "@/lib/import/history";

// Settings → Import: bring past ChatGPT / Claude conversations into Orbit so switching doesn't mean losing them.
const HOW: Record<"chatgpt" | "claude", string> = {
  chatgpt: "ChatGPT → Settings → Data controls → Export data. You'll get an email with a .zip.",
  claude: "Claude → Settings → Privacy → Export data. You'll get an email with a .zip.",
};

export function ImportHistory({ onImported }: { onImported: (provider: ProviderId) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedExport | null>(null);
  const [target, setTarget] = useState<ProviderId>("openai");
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);

  async function choose(file: File | undefined) {
    if (!file) return;
    setParsed(null);
    setStatus("Reading the export…");
    try {
      const p = await readExportFile(file);
      setParsed(p);
      setTarget(p.source === "claude" ? "anthropic" : "openai");
      setStatus(null);
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  async function run() {
    if (!parsed) return;
    setBusy(true);
    const batches = importBatches(parsed.chats);
    let imported = 0;
    let duplicates = 0;
    setProgress({ done: 0, total: parsed.chats.length });
    for (const [i, chats] of batches.entries()) {
      const res = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: target, source: parsed.source, chats }) }).catch(() => null);
      if (!res?.ok) {
        const err = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
        setStatus(err?.error === "db_setup" ? "Importing isn't set up yet: run migration 0012 in Supabase." : `Stopped after ${imported} chats (a request failed). Run it again; chats already imported are skipped.`);
        setBusy(false);
        setProgress(null);
        if (imported) onImported(target);
        return;
      }
      const out = (await res.json()) as { imported: number; duplicates: number };
      imported += out.imported;
      duplicates += out.duplicates;
      setProgress({ done: batches.slice(0, i + 1).reduce((n, b) => n + b.length, 0), total: parsed.chats.length });
    }
    setBusy(false);
    setProgress(null);
    setParsed(null);
    setStatus(`Imported ${imported} chat${imported === 1 ? "" : "s"} into ${THEMES[target].appName}${duplicates ? ` (${duplicates} already imported, skipped)` : ""}. They're in its chat list.`);
    onImported(target);
  }

  const messages = parsed?.chats.reduce((n, c) => n + c.messages.length, 0) ?? 0;
  return (
    <div>
      <h3 className="text-base font-medium">Import past conversations</h3>
      <p className="mt-1 text-sm text-ink-muted">Bring your ChatGPT or Claude history with you. Imported chats work like any other: you can keep talking in them with any model.</p>
      <ul className="mt-3 space-y-1.5 text-sm text-ink-muted">
        <li><span className="font-medium text-ink">ChatGPT:</span> {HOW.chatgpt}</li>
        <li><span className="font-medium text-ink">Claude:</span> {HOW.claude}</li>
      </ul>
      <input ref={input} type="file" accept=".zip,.json,application/zip,application/json" hidden onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} />
      <button type="button" onClick={() => input.current?.click()} disabled={busy}
        className="mt-4 rounded-full border border-line-strong px-4 py-2 text-sm font-medium hover:bg-surface-300 disabled:opacity-60">Choose the export file (.zip)</button>

      {parsed && (
        <div className="mt-4 rounded-2xl border border-line p-4">
          <p className="text-sm">
            Found <span className="font-medium">{parsed.chats.length.toLocaleString()} {parsed.source === "chatgpt" ? "ChatGPT" : "Claude"} chats</span> ({messages.toLocaleString()} messages)
            {parsed.skipped ? <span className="text-ink-subtle"> · {parsed.skipped} empty or extra skipped</span> : null}.
          </p>
          <label className="mt-3 flex items-center gap-2 text-sm">
            Put them in
            <select value={target} onChange={(e) => setTarget(e.target.value as ProviderId)} disabled={busy}
              className="rounded-full border border-line bg-surface-100 px-3 py-1 text-sm outline-none">
              {PROVIDERS.map((p) => <option key={p} value={p}>{THEMES[p].appName}</option>)}
            </select>
          </label>
          <p className="mt-2 text-xs text-ink-subtle">Only text is imported (no images or files). Importing is free and doesn&apos;t use your budget.</p>
          <button type="button" onClick={run} disabled={busy}
            className="mt-3 rounded-full bg-brand px-5 py-2 text-sm font-medium text-on-brand disabled:opacity-60">
            {busy && progress ? `Importing… ${progress.done}/${progress.total}` : `Import ${parsed.chats.length.toLocaleString()} chats`}
          </button>
        </div>
      )}
      {status && <p role="status" className="mt-3 text-sm text-ink-muted">{status}</p>}
    </div>
  );
}
