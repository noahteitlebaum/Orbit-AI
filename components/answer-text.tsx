"use client";

import { Fragment, useState } from "react";
import { hideQuizMarkers } from "@/lib/chat/quiz";

// An answer with its course-file references. [S1] markers become small numbered chips; the list under the
// answer shows exactly which file and page/slide each one came from (only passages the answer actually cited).
// kind "web" = a web search result, cited as [W#], with a link; otherwise a course-file passage, cited as [S#].
export type Source = { n: number; fileId: string; fileName: string; page: number | null; label: string; excerpt: string; kind?: "web"; url?: string };
const tagOf = (s: Pick<Source, "kind" | "n">) => `${s.kind === "web" ? "W" : "S"}${s.n}`;

/** Pure: the answer split into text and citation parts. Once final, markers with no real passage are dropped. */
export function citationParts(text: string, sources: Source[] | undefined, final: boolean): ({ text: string } | { n: number; web?: boolean; source?: Source })[] {
  const byTag = new Map((sources ?? []).map((s) => [tagOf(s), s]));
  const out: ({ text: string } | { n: number; web?: boolean; source?: Source })[] = [];
  for (const part of text.split(/(\s?\[[SW]\d+\])/g)) {
    const m = /^\s?\[([SW])(\d+)\]$/.exec(part);
    if (!m) {
      if (part) out.push({ text: part });
      continue;
    }
    const source = byTag.get(`${m[1]}${m[2]}`);
    if (final && !source) continue; // a citation that doesn't point at a passage or result we sent: never show it
    if (part.startsWith(" ") || part.startsWith("\n")) out.push({ text: part[0] });
    out.push({ n: Number(m[2]), ...(m[1] === "W" ? { web: true } : {}), source });
  }
  return out;
}

export function AnswerText({ text, sources, final = true }: { text: string; sources?: Source[]; final?: boolean }) {
  return (
    <>
      {citationParts(hideQuizMarkers(text), sources, final).map((p, i) =>
        "text" in p ? (
          <Fragment key={i}>{p.text}</Fragment>
        ) : (
          p.web && p.source?.url ? (
            <a key={i} href={p.source.url} target="_blank" rel="noreferrer" title={p.source.label}
              className="mx-0.5 inline-grid h-4 min-w-4 place-items-center rounded-full border border-line-strong px-1 align-[2px] font-sans text-[10px] font-semibold text-ink-muted no-underline hover:text-ink">
              W{p.n}
            </a>
          ) : (
            <sup key={i} title={p.source?.label}
              className="mx-0.5 inline-grid h-4 min-w-4 place-items-center rounded-full bg-surface-300 px-1 align-[2px] font-sans text-[10px] font-semibold text-ink-muted">
              {p.web ? `W${p.n}` : p.n}
            </sup>
          )
        ),
      )}
    </>
  );
}

export function SourceList({ sources }: { sources: Source[] }) {
  const files = sources.filter((s) => s.kind !== "web");
  const web = sources.filter((s) => s.kind === "web");
  return (
    <>
      {files.length > 0 && <SourceGroup title="From your files · tap a source to check the passage" sources={files} />}
      {web.length > 0 && <SourceGroup title="From the web · check the page before relying on it" sources={web} />}
    </>
  );
}

function SourceGroup({ title, sources }: { title: string; sources: Source[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = sources.find((s) => tagOf(s) === open);
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-xs font-medium text-ink-subtle">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((s) => (
          <button key={tagOf(s)} type="button" onClick={() => setOpen(open === tagOf(s) ? null : tagOf(s))} aria-expanded={open === tagOf(s)}
            className={`flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${open === tagOf(s) ? "border-line-strong bg-surface-300" : "border-line bg-surface-200 hover:bg-surface-300"}`}>
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-surface-000 px-1 text-[10px] font-semibold">{s.kind === "web" ? `W${s.n}` : s.n}</span>
            <span className="truncate">{s.label}</span>
          </button>
        ))}
      </div>
      {shown && (
        <blockquote className="mt-2 rounded-xl border-l-2 border-brand bg-surface-200 px-3 py-2 text-xs leading-relaxed text-ink-muted">
          <span className="mb-1 block font-medium text-ink">{shown.label}</span>
          {shown.excerpt.startsWith("(") ? shown.excerpt : `“${shown.excerpt}${shown.excerpt.length >= 600 ? "…" : ""}”`}
          {shown.url && (
            <a href={shown.url} target="_blank" rel="noreferrer" className="mt-1.5 block break-all font-medium text-ink underline underline-offset-[3px]">
              {shown.url}
            </a>
          )}
        </blockquote>
      )}
    </div>
  );
}
