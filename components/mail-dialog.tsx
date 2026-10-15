"use client";

import { useEffect, useRef, useState } from "react";
import {
  bundleEmails, bundleEvents, eventDate, googleEvents, MAIL_LIMITS, outlookEvents, readGmail, readOutlook, searchGmail, searchOutlook,
  type CalEvent, type MailSource, type MailSummary,
} from "@/lib/connectors/mail-calendar";
import { ConnectorError } from "@/lib/connectors/types";

// Email (Outlook / Gmail) and calendar (Outlook / Google) pickers. Read-only; the result is one Markdown file.
export type MailTarget = { kind: "mail"; source: MailSource } | { kind: "calendar"; source: "outlook" | "google" } | null;

const NAMES = { outlook: "Outlook", gmail: "Gmail", google: "Google Calendar" } as const;
const day = (iso: string) => {
  const d = eventDate(iso);
  if (Number.isNaN(+d)) return "";
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-CA", { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
};
const fileStamp = () => new Date().toISOString().slice(0, 10);

export function MailDialog({ target, onClose, onPicked }: { target: MailTarget; onClose: () => void; onPicked: (files: File[]) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState("");
  const [mails, setMails] = useState<MailSummary[] | null>(null);
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [days, setDays] = useState(MAIL_LIMITS.days);

  const title = !target ? "" : target.kind === "mail" ? `Add from ${NAMES[target.source]}` : `Add from ${target.source === "outlook" ? "Outlook Calendar" : NAMES.google}`;

  async function run<T>(what: () => Promise<T>, done: (v: T) => void) {
    setBusy(true);
    setStatus(null);
    try {
      done(await what());
    } catch (e) {
      setStatus(e instanceof ConnectorError ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const search = (text: string) => target?.kind === "mail" &&
    run(() => (target.source === "gmail" ? searchGmail(text) : searchOutlook(text)), (m) => { setMails(m); setPicked(new Set()); });
  const loadEvents = (n: number) => target?.kind === "calendar" &&
    run(() => (target.source === "google" ? googleEvents(new Date(), n) : outlookEvents(new Date(), n)), setEvents);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (target && !d.open) {
      d.showModal();
      setQ("");
      setMails(null);
      setEvents(null);
      setPicked(new Set());
      setStatus(null);
      setDays(MAIL_LIMITS.days);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when opened
      if (target.kind === "mail") void search("");
      else void loadEvents(MAIL_LIMITS.days);
    } else if (!target && d.open) d.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the dialog opens for a new source
  }, [target]);

  function toggle(id: string) {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAIL_LIMITS.pick) next.add(id);
      return next;
    });
  }

  function addMail() {
    if (target?.kind !== "mail") return;
    const ids = (mails ?? []).filter((m) => picked.has(m.id)).map((m) => m.id);
    void run(() => (target.source === "gmail" ? readGmail(ids) : readOutlook(ids)), (full) => {
      onPicked([new File([bundleEmails(target.source, full)], `${target.source}-emails-${fileStamp()}.md`, { type: "text/markdown" })]);
      onClose();
    });
  }

  function addEvents() {
    if (target?.kind !== "calendar" || !events) return;
    onPicked([new File([bundleEvents(target.source, events, new Date(), days)], `${target.source}-calendar-${fileStamp()}.md`, { type: "text/markdown" })]);
    onClose();
  }

  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto h-[min(88dvh,640px)] w-[min(94vw,560px)] rounded-3xl border border-line bg-composer p-0 text-ink shadow-menu backdrop:bg-black/50">
      <div className="flex h-full flex-col p-5">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-medium">{title}</h2>
          <span className="rounded-full bg-surface-200 px-2 py-0.5 text-[11px] text-ink-subtle">read-only</span>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded-full px-2.5 py-1 text-ink-muted hover:bg-surface-300">✕</button>
        </div>

        {target?.kind === "mail" && (
          <>
            <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void search(q); }}>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={target.source === "gmail" ? "Search (e.g. from:prof subject:midterm)" : "Search your email"}
                aria-label="Search email" className="min-w-0 flex-1 rounded-xl border border-line-strong bg-surface-000 px-3.5 py-2 text-sm outline-none focus:border-brand" />
              <button type="submit" disabled={busy} className="rounded-full border border-line-strong px-4 py-2 text-sm font-medium hover:bg-surface-300 disabled:opacity-50">Search</button>
            </form>
            <ul className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line" aria-label="Emails">
              {mails === null && busy && <li className="p-4 text-sm text-ink-subtle">Loading…</li>}
              {mails?.length === 0 && <li className="p-4 text-sm text-ink-subtle">No emails found.</li>}
              {mails?.map((m) => (
                <li key={m.id} className="border-b border-line last:border-0">
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-surface-200">
                    <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} className="mt-1 h-4 w-4 shrink-0 accent-[var(--brand)]" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.from.replace(/\s*<[^>]+>/, "") || "(unknown sender)"}</span>
                        <span className="shrink-0 text-xs text-ink-subtle">{day(m.date)}</span>
                      </span>
                      <span className="block truncate text-sm">{m.subject || "(no subject)"}</span>
                      <span className="block truncate text-xs text-ink-subtle">{m.snippet}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center gap-2">
              <p className="text-xs text-ink-subtle">{picked.size} of {MAIL_LIMITS.pick} selected</p>
              <button type="button" onClick={addMail} disabled={!picked.size || busy}
                className="ml-auto rounded-full bg-brand px-5 py-2 text-sm font-medium text-on-brand disabled:opacity-50">{busy && mails ? "Adding…" : "Add to chat"}</button>
            </div>
          </>
        )}

        {target?.kind === "calendar" && (
          <>
            <div className="mt-3 flex items-center gap-2 text-sm">
              <span className="text-ink-muted">Next</span>
              {[7, 14, 30].map((n) => (
                <button key={n} type="button" onClick={() => { setDays(n); void loadEvents(n); }} disabled={busy}
                  className={`rounded-full px-3 py-1 text-xs ${days === n ? "bg-surface-300 font-medium" : "border border-line hover:bg-surface-200"}`}>{n} days</button>
              ))}
            </div>
            <ul className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line" aria-label="Events">
              {events === null && busy && <li className="p-4 text-sm text-ink-subtle">Loading…</li>}
              {events?.length === 0 && <li className="p-4 text-sm text-ink-subtle">Nothing on your calendar in this range.</li>}
              {events?.map((e, i) => (
                <li key={i} className="flex gap-3 border-b border-line px-3 py-2.5 last:border-0">
                  <span className="w-20 shrink-0 text-xs text-ink-subtle">{day(e.start)}{!e.allDay && <><br />{new Date(e.start).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}</>}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{e.title || "(no title)"}</span>
                    {e.location && <span className="block truncate text-xs text-ink-subtle">{e.location}</span>}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center gap-2">
              <p className="text-xs text-ink-subtle">{events ? `${events.length} event${events.length === 1 ? "" : "s"}` : ""}</p>
              <button type="button" onClick={addEvents} disabled={!events?.length || busy}
                className="ml-auto rounded-full bg-brand px-5 py-2 text-sm font-medium text-on-brand disabled:opacity-50">Add to chat</button>
            </div>
          </>
        )}
        {status && <p role="status" className="mt-2 text-sm text-ink-muted">{status}</p>}
      </div>
    </dialog>
  );
}
