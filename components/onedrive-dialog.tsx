"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { downloadOneDrive, listOneDrive, searchOneDrive, type DriveItem } from "@/lib/connectors/onedrive";
import { ConnectorError, MAX_CLOUD_FILES } from "@/lib/connectors/types";

// Browse the student's OneDrive and pick files to add to the message (they then upload like any other file).
export function OneDriveDialog({ open, onClose, onPicked }: { open: boolean; onClose: () => void; onPicked: (files: File[]) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState<{ id: string | null; name: string }[]>([{ id: null, name: "My files" }]);
  const [items, setItems] = useState<DriveItem[] | null>(null);
  const [picked, setPicked] = useState<Map<string, DriveItem>>(new Map());
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (run: () => Promise<DriveItem[]>) => {
    setItems(null);
    setStatus(null);
    try {
      setItems(await run());
    } catch (e) {
      setItems([]);
      setStatus(e instanceof ConnectorError ? e.message : "Couldn't reach OneDrive. Try again.");
    }
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setPath([{ id: null, name: "My files" }]);
      setPicked(new Map());
      setQuery("");
      void load(() => listOneDrive(null));
    } else if (!open && d.open) d.close();
  }, [open, load]);

  function openFolder(item: DriveItem) {
    setPath((p) => [...p, { id: item.id, name: item.name }]);
    void load(() => listOneDrive(item.id));
  }
  function goTo(i: number) {
    const target = path[i];
    setPath(path.slice(0, i + 1));
    void load(() => listOneDrive(target.id));
  }
  function toggle(item: DriveItem) {
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(item.id)) next.delete(item.id);
      else if (next.size < MAX_CLOUD_FILES) next.set(item.id, item);
      return next;
    });
  }
  async function add() {
    setBusy(true);
    const files: File[] = [];
    try {
      for (const item of picked.values()) {
        setStatus(`Getting ${item.name}…`);
        files.push(await downloadOneDrive(item));
      }
      onPicked(files);
      onClose();
    } catch (e) {
      setStatus(e instanceof ConnectorError ? e.message : "Couldn't download from OneDrive.");
    } finally {
      setBusy(false);
    }
  }

  const size = (n?: number) => (n == null ? "" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto h-[min(85dvh,620px)] w-[min(94vw,560px)] rounded-3xl border border-line bg-composer p-0 text-ink shadow-menu backdrop:bg-black/50">
      <div className="flex h-full flex-col p-5">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-medium">OneDrive</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded-full px-2.5 py-1 text-ink-muted hover:bg-surface-300">✕</button>
        </div>
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (query.trim()) { setPath([{ id: null, name: `Search: ${query.trim()}` }]); void load(() => searchOneDrive(query.trim())); } }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your OneDrive" aria-label="Search OneDrive"
            className="min-w-0 flex-1 rounded-xl border border-line-strong bg-surface-000 px-3.5 py-2 text-sm outline-none focus:border-brand" />
          <button type="submit" className="rounded-full border border-line-strong px-4 py-2 text-sm font-medium hover:bg-surface-300">Search</button>
        </form>
        <nav aria-label="Folder path" className="mt-3 flex flex-wrap items-center gap-1 text-xs text-ink-muted">
          {path.map((p, i) => (
            <span key={`${p.id}-${i}`} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden>›</span>}
              <button type="button" onClick={() => goTo(i)} disabled={i === path.length - 1} className="rounded px-1 hover:text-ink disabled:font-medium disabled:text-ink">{p.name}</button>
            </span>
          ))}
        </nav>
        <ul className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line" aria-label="Files">
          {items === null && <li className="p-4 text-sm text-ink-subtle">Loading…</li>}
          {items?.length === 0 && !status && <li className="p-4 text-sm text-ink-subtle">Nothing here.</li>}
          {items?.map((it) => (
            <li key={it.id} className="border-b border-line last:border-0">
              {it.folder ? (
                <button type="button" onClick={() => openFolder(it)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-surface-200">
                  <span aria-hidden>📁</span><span className="min-w-0 flex-1 truncate">{it.name}</span>
                  <span className="text-xs text-ink-subtle">{it.folder.childCount ?? ""}</span>
                </button>
              ) : (
                <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm hover:bg-surface-200">
                  <input type="checkbox" checked={picked.has(it.id)} onChange={() => toggle(it)} className="h-4 w-4 accent-[var(--brand)]" />
                  <span className="min-w-0 flex-1 truncate">{it.name}</span>
                  <span className="text-xs text-ink-subtle">{size(it.size)}</span>
                </label>
              )}
            </li>
          ))}
        </ul>
        {status && <p role="status" className="mt-2 text-sm text-ink-muted">{status}</p>}
        <div className="mt-3 flex items-center justify-between gap-2">
          <p className="text-xs text-ink-subtle">Read-only. Up to {MAX_CLOUD_FILES} files.</p>
          <button type="button" onClick={add} disabled={!picked.size || busy}
            className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-on-brand disabled:opacity-50">
            {busy ? "Adding…" : picked.size ? `Add ${picked.size} file${picked.size === 1 ? "" : "s"}` : "Add files"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
