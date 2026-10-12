"use client";

import { Fragment, useState } from "react";
import { hideQuizMarkers } from "@/lib/chat/quiz";

// An answer with its course-file references. [S1] markers become small numbered chips; the list under the
// answer shows exactly which file and page/slide each one came from (only passages the answer actually cited).
export type Source = { n: number; fileId: string; fileName: string; page: number | null; label: string; excerpt: string };

/** Pure: the answer split into text and citation parts. Once final, markers with no real passage are dropped. */
export function citationParts(text: string, sources: Source[] | undefined, final: boolean): ({ text: string } | { n: number; source?: Source })[] {
  const byN = new Map((sources ?? []).map((s) => [s.n, s]));
  const out: ({ text: string } | { n: number; source?: Source })[] = [];
  for (const part of text.split(/(\s?\[S\d+\])/g)) {
    const m = /^\s?\[S(\d+)\]$/.exec(part);
    if (!m) {
      if (part) out.push({ text: part });
      continue;
    }
    const source = byN.get(Number(m[1]));
    if (final && !source) continue; // a citation that doesn't point at a passage we sent: never show it
    if (part.startsWith(" ") || part.startsWith("\n")) out.push({ text: part[0] });
    out.push({ n: Number(m[1]), source });
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
          <sup key={i} title={p.source?.label}
            className="mx-0.5 inline-grid h-4 min-w-4 place-items-center rounded-full bg-surface-300 px-1 align-[2px] font-sans text-[10px] font-semibold text-ink-muted">
            {p.n}
          </sup>
        ),
      )}
    </>
  );
}

export function SourceList({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = sources.find((s) => s.n === open);
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-xs font-medium text-ink-subtle">From your files · tap a source to check the passage</p>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((s) => (
          <button key={s.n} type="button" onClick={() => setOpen(open === s.n ? null : s.n)} aria-expanded={open === s.n}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${open === s.n ? "border-line-strong bg-surface-300" : "border-line bg-surface-200 hover:bg-surface-300"}`}>
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-surface-000 px-1 text-[10px] font-semibold">{s.n}</span>
            {s.label}
          </button>
        ))}
      </div>
      {shown && (
        <blockquote className="mt-2 rounded-xl border-l-2 border-brand bg-surface-200 px-3 py-2 text-xs leading-relaxed text-ink-muted">
          <span className="mb-1 block font-medium text-ink">{shown.label}</span>
          {shown.excerpt.startsWith("(") ? shown.excerpt : `“${shown.excerpt}${shown.excerpt.length >= 600 ? "…" : ""}”`}
        </blockquote>
      )}
    </div>
  );
}
