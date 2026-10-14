"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { bundleNotion, NOTION_LIMITS, type NotionPage } from "@/lib/connectors/notion";
import { notionSession, notionSignInConfigured, readNotion, searchNotion, setNotionSession, signInToNotion } from "@/lib/connectors/notion-client";
import { ConnectorError } from "@/lib/connectors/types";
import { youtubeId } from "@/lib/connectors/youtube";
import { connectZotero, readZotero, searchZotero, setZoteroAuth, ZOTERO_LIMITS, zoteroAuth, type ZoteroAuth, type ZoteroItem } from "@/lib/connectors/zotero";

// Notion, Zotero and YouTube pickers. Each one ends in a Markdown file (or, for YouTube, a link in the message).
const stamp = () => new Date().toISOString().slice(0, 10);
const errText = (e: unknown) => (e instanceof ConnectorError ? e.message : "Something went wrong. Try again.");
const ago = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? "" : d.toLocaleDateString("en-CA", { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
};
const input = "min-w-0 flex-1 rounded-xl border border-line-strong bg-surface-000 px-3.5 py-2 text-sm outline-none focus:border-brand";
const primary = "rounded-full bg-brand px-5 py-2 text-sm font-medium text-on-brand disabled:opacity-50";
const secondary = "rounded-full border border-line-strong px-4 py-2 text-sm font-medium hover:bg-surface-300 disabled:opacity-50";

function Shell({ open, onClose, title, badge, size = "tall", children }: { open: boolean; onClose: () => void; title: string; badge?: string; size?: "tall" | "short"; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}
      className={`m-auto w-[min(94vw,560px)] rounded-3xl border border-line bg-composer p-0 text-ink shadow-menu backdrop:bg-black/50 ${size === "tall" ? "h-[min(88dvh,640px)]" : ""}`}>
      <div className="flex h-full flex-col p-5">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-medium">{title}</h2>
          {badge && <span className="rounded-full bg-surface-200 px-2 py-0.5 text-[11px] text-ink-subtle">{badge}</span>}
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded-full px-2.5 py-1 text-ink-muted hover:bg-surface-300">✕</button>
        </div>
        {open && children}
      </div>
    </dialog>
  );
}

function PickList<T>({ items, keyOf, picked, onToggle, empty, render, label }: {
  items: T[] | null; keyOf: (t: T) => string; picked: Set<string>; onToggle: (k: string) => void; empty: string; render: (t: T) => ReactNode; label: string;
}) {
  return (
    <ul className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line" aria-label={label}>
      {items === null && <li className="p-4 text-sm text-ink-subtle">Loading…</li>}
      {items?.length === 0 && <li className="p-4 text-sm text-ink-subtle">{empty}</li>}
      {items?.map((t) => (
        <li key={keyOf(t)} className="border-b border-line last:border-0">
          <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-surface-200">
            <input type="checkbox" checked={picked.has(keyOf(t))} onChange={() => onToggle(keyOf(t))} className="mt-1 h-4 w-4 shrink-0 accent-[var(--brand)]" />
            <span className="min-w-0 flex-1">{render(t)}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function usePicks(max: number) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(k)) next.delete(k);
    else if (next.size < max) next.add(k);
    return next;
  });
  return { picked, toggle, reset: () => setPicked(new Set()) };
}

// ---------------------------------------------------------------- Notion
export function NotionDialog({ open, onClose, onPicked }: { open: boolean; onClose: () => void; onPicked: (files: File[]) => void }) {
  const [session, setSession] = useState<{ token: string; workspace: string } | null>(null);
  const [q, setQ] = useState("");
  const [pages, setPages] = useState<NotionPage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const { picked, toggle, reset } = usePicks(NOTION_LIMITS.pick);

  async function search(token: string, text: string) {
    setPages(null);
    reset();
    try {
      setPages(await searchNotion(token, text));
    } catch (e) {
      setPages([]);
      setStatus(errText(e));
      if (!notionSession()) setSession(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    const s = notionSession();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when opened
    setSession(s);
    setStatus(null);
    setQ("");
    if (s) void search(s.token, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load when opened
  }, [open]);

  async function connect() {
    setBusy(true);
    setStatus(null);
    try {
      const s = await signInToNotion();
      setSession(s);
      void search(s.token, "");
    } catch (e) {
      setStatus(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!session || !pages) return;
    setBusy(true);
    setStatus("Reading pages…");
    try {
      const chosen = pages.filter((p) => picked.has(p.id)).map((p) => ({ id: p.id, kind: p.kind }));
      const md = bundleNotion(await readNotion(session.token, chosen));
      onPicked([new File([md], `notion-${stamp()}.md`, { type: "text/markdown" })]);
      onClose();
    } catch (e) {
      setStatus(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell open={open} onClose={onClose} title="Add from Notion" badge="read-only">
      {!notionSignInConfigured ? (
        <p className="mt-4 text-sm text-ink-muted">Notion isn&apos;t set up on this server yet (NEXT_PUBLIC_NOTION_CLIENT_ID).</p>
      ) : !session ? (
        <div className="mt-6 flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="max-w-sm text-sm text-ink-muted">Connect Notion and choose which pages Orbit may read. You can change this anytime in Notion&apos;s settings.</p>
          <button type="button" onClick={connect} disabled={busy} className={primary}>{busy ? "Waiting for Notion…" : "Connect Notion"}</button>
        </div>
      ) : (
        <>
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void search(session.token, q); }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${session.workspace}`} aria-label="Search Notion" className={input} />
            <button type="submit" className={secondary}>Search</button>
          </form>
          <PickList label="Notion pages" items={pages} keyOf={(p) => p.id} picked={picked} onToggle={toggle}
            empty="No pages found. Pages appear here once you share them with Orbit in Notion."
            render={(p) => (
              <span className="flex items-baseline gap-2">
                <span className="w-5 shrink-0 text-center">{p.icon ?? (p.kind === "database" ? "▦" : "📄")}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{p.title}</span>
                <span className="shrink-0 text-xs text-ink-subtle">{ago(p.edited)}</span>
              </span>
            )} />
          <div className="mt-3 flex items-center gap-3">
            <button type="button" onClick={() => { setNotionSession(null); setSession(null); setPages(null); }} className="text-xs text-ink-subtle underline underline-offset-[3px] hover:text-ink">Disconnect</button>
            <p className="ml-auto text-xs text-ink-subtle">{picked.size} of {NOTION_LIMITS.pick}</p>
            <button type="button" onClick={add} disabled={!picked.size || busy} className={primary}>{busy ? "Adding…" : "Add to chat"}</button>
          </div>
        </>
      )}
      {status && <p role="status" className="mt-2 text-sm text-ink-muted">{status}</p>}
    </Shell>
  );
}

// ---------------------------------------------------------------- Zotero
export function ZoteroDialog({ open, onClose, onPicked }: { open: boolean; onClose: () => void; onPicked: (files: File[]) => void }) {
  const [auth, setAuth] = useState<ZoteroAuth | null>(null);
  const [key, setKey] = useState("");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ZoteroItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const { picked, toggle, reset } = usePicks(ZOTERO_LIMITS.pick);

  async function search(a: ZoteroAuth, text: string) {
    setItems(null);
    reset();
    try {
      setItems(await searchZotero(a, text));
    } catch (e) {
      setItems([]);
      setStatus(errText(e));
    }
  }

  useEffect(() => {
    if (!open) return;
    const a = zoteroAuth();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when opened
    setAuth(a);
    setStatus(null);
    setQ("");
    setKey("");
    if (a) void search(a, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load when opened
  }, [open]);

  async function connect() {
    setBusy(true);
    setStatus(null);
    try {
      const a = await connectZotero(key);
      setAuth(a);
      void search(a, "");
    } catch (e) {
      setStatus(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!auth || !items) return;
    setBusy(true);
    setStatus("Reading notes…");
    try {
      const md = await readZotero(auth, items.filter((i) => picked.has(i.key)));
      onPicked([new File([md], `zotero-sources-${stamp()}.md`, { type: "text/markdown" })]);
      onClose();
    } catch (e) {
      setStatus(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const authors = (i: ZoteroItem) => {
    const a = i.creators.map((c) => c.lastName ?? c.name ?? "").filter(Boolean);
    return a.length > 2 ? `${a[0]} et al.` : a.join(" & ");
  };

  return (
    <Shell open={open} onClose={onClose} title="Add from Zotero" badge="read-only">
      {!auth ? (
        <div className="mt-4 flex flex-col gap-3 text-sm">
          <p className="text-ink-muted">Bring in references, abstracts and your notes so answers can cite your sources.</p>
          <ol className="list-decimal space-y-1 pl-5 text-ink-muted">
            <li>Open <a href="https://www.zotero.org/settings/keys/new" target="_blank" rel="noreferrer" className="font-medium text-ink underline underline-offset-[3px]">zotero.org/settings/keys/new</a></li>
            <li>Tick <b>Allow library access</b> only (leave write access off) and save.</li>
            <li>Paste the key here. It stays in this browser.</li>
          </ol>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
            <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Zotero API key" aria-label="Zotero API key" autoComplete="off" spellCheck={false} className={`${input} font-mono`} />
            <button type="submit" disabled={busy || !key.trim()} className={primary}>{busy ? "Checking…" : "Connect"}</button>
          </form>
        </div>
      ) : (
        <>
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void search(auth, q); }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, author or year" aria-label="Search Zotero" className={input} />
            <button type="submit" className={secondary}>Search</button>
          </form>
          <PickList label="Zotero items" items={items} keyOf={(i) => i.key} picked={picked} onToggle={toggle} empty="Nothing in your library matches."
            render={(i) => (
              <>
                <span className="block truncate text-sm font-medium">{i.title || "Untitled"}</span>
                <span className="block truncate text-xs text-ink-subtle">{[authors(i), i.date?.match(/\d{4}/)?.[0], i.publicationTitle].filter(Boolean).join(" · ")}</span>
              </>
            )} />
          <div className="mt-3 flex items-center gap-3">
            <button type="button" onClick={() => { setZoteroAuth(null); setAuth(null); setItems(null); }} className="text-xs text-ink-subtle underline underline-offset-[3px] hover:text-ink">Forget key ({auth.username})</button>
            <p className="ml-auto text-xs text-ink-subtle">{picked.size} of {ZOTERO_LIMITS.pick}</p>
            <button type="button" onClick={add} disabled={!picked.size || busy} className={primary}>{busy ? "Adding…" : "Add to chat"}</button>
          </div>
        </>
      )}
      {status && <p role="status" className="mt-2 text-sm text-ink-muted">{status}</p>}
    </Shell>
  );
}

// ---------------------------------------------------------------- YouTube
export function YouTubeDialog({ open, onClose, onAdd, isGemini }: { open: boolean; onClose: () => void; onAdd: (url: string) => void; isGemini: boolean }) {
  const [link, setLink] = useState("");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when opened
    if (open) setLink("");
  }, [open]);
  const id = youtubeId(link.trim());
  return (
    <Shell open={open} onClose={onClose} title="Add a YouTube video" size="short">
      <form className="mt-3 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (id) { onAdd(`https://www.youtube.com/watch?v=${id}`); onClose(); } }}>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" aria-label="YouTube link" autoFocus className={input} />
        {id && (
          // eslint-disable-next-line @next/next/no-img-element -- remote thumbnail, no optimisation needed
          <img src={`https://i.ytimg.com/vi/${id}/mqdefault.jpg`} alt="Video thumbnail" className="aspect-video w-full rounded-2xl border border-line object-cover" />
        )}
        <p className="text-xs text-ink-subtle">
          {isGemini
            ? "Gemini watches the video (sound and picture) to answer. Public videos only; longer videos cost more."
            : "Only Gemini can watch videos. Orbit will switch this chat to Gemini and put the link in your message."}
        </p>
        <div className="flex justify-end">
          <button type="submit" disabled={!id} className={primary}>{isGemini ? "Add to message" : "Open in Gemini"}</button>
        </div>
      </form>
    </Shell>
  );
}
