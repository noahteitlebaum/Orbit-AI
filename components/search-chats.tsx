"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// "Search chats" (⌘K / Ctrl+K), like the apps: type to filter this app's chats by name, arrows + Enter to open.
export type ChatRow = { id: string; title: string; updatedAt: string };

/** Chats matching every word of the query (case/accent-insensitive), newest first. Pure. */
export function matchChats(chats: ChatRow[], q: string): ChatRow[] {
  const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const words = norm(q).split(/\s+/).filter(Boolean);
  return chats.filter((c) => words.every((w) => norm(c.title || "Untitled").includes(w))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const when = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  return days < 1 ? "Today" : days < 2 ? "Yesterday" : days < 7 ? `${days} days ago` : d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
};

export function SearchChats({ open, onClose, chats, onOpen, onNew, appName }: {
  open: boolean; onClose: () => void; chats: ChatRow[]; onOpen: (id: string) => void; onNew: () => void; appName: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setQ("");
      setAt(0);
    } else if (!open && d.open) d.close();
  }, [open]);
  const hits = useMemo(() => matchChats(chats, q).slice(0, 50), [chats, q]);
  const pick = (i: number) => {
    const c = hits[i];
    if (c) { onOpen(c.id); onClose(); }
  };
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-label="Search chats"
      className="m-auto mt-[12vh] w-[min(94vw,640px)] rounded-3xl border border-line bg-composer p-0 text-ink shadow-menu backdrop:bg-black/40">
      <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden className="shrink-0 text-ink-subtle"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        <input autoFocus value={q} placeholder={`Search ${appName} chats…`} aria-label="Search chats"
          onChange={(e) => { setQ(e.target.value); setAt(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setAt((a) => Math.min(a + 1, hits.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); }
            if (e.key === "Enter") { e.preventDefault(); pick(at); }
          }}
          className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-subtle" />
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-full px-2 py-0.5 text-ink-muted hover:bg-surface-300">✕</button>
      </div>
      <ul className="max-h-[60vh] overflow-y-auto p-2" role="listbox" aria-label="Matching chats">
        {!q && (
          <li>
            <button type="button" onClick={() => { onNew(); onClose(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-surface-200">
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden><path d="M11.5 4.5H5.5a1.5 1.5 0 0 0-1.5 1.5v8.5A1.5 1.5 0 0 0 5.5 16H14a1.5 1.5 0 0 0 1.5-1.5v-6M13.6 3.4a1.4 1.4 0 0 1 2 2L10 11l-2.6.6.6-2.6 5.6-5.6z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              New chat
            </button>
          </li>
        )}
        {hits.map((c, i) => (
          <li key={c.id} role="option" aria-selected={i === at}>
            <button type="button" onMouseEnter={() => setAt(i)} onClick={() => pick(i)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm ${i === at ? "bg-surface-200" : ""}`}>
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden className="shrink-0 text-ink-subtle"><path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
              <span className="min-w-0 flex-1 truncate">{c.title || "Untitled"}</span>
              <span className="shrink-0 text-xs text-ink-subtle">{when(c.updatedAt)}</span>
            </button>
          </li>
        ))}
        {q && hits.length === 0 && <li className="px-3 py-6 text-center text-sm text-ink-subtle">No chats match “{q}”.</li>}
      </ul>
    </dialog>
  );
}
