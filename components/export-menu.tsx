"use client";

import { useEffect, useRef, useState } from "react";

// A small "Download" menu: each option saves one file (Markdown, text, CSV…).
export type ExportOption = { label: string; hint?: string; run: () => void };

export function ExportMenu({ options, label = "Download", align = "left", compact = false }: { options: ExportOption[]; label?: string; align?: "left" | "right"; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" {...(compact ? { "aria-label": label, title: label } : {})}
        className={compact ? `grid h-8 w-8 place-items-center rounded-lg text-ink-muted transition hover:bg-surface-200 hover:text-ink ${open ? "bg-surface-200 text-ink" : ""}` : "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-ink-muted hover:bg-surface-200 hover:text-ink"}>
        <svg viewBox="0 0 16 16" width={compact ? 16 : 13} height={compact ? 16 : 13} aria-hidden><path d="M8 2.5v7.5m0 0L5 7m3 3 3-3M3 12.5h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {!compact && label}
      </button>
      {open && (
        <ul role="menu" className={`absolute z-20 mt-1 min-w-52 rounded-2xl border border-line bg-composer p-1 shadow-menu ${align === "right" ? "right-0" : "left-0"}`}>
          {options.map((o) => (
            <li key={o.label} role="none">
              <button type="button" role="menuitem" onClick={() => { o.run(); setOpen(false); }}
                className="block w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-surface-300">
                {o.label}
                {o.hint && <span className="block text-xs text-ink-subtle">{o.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
