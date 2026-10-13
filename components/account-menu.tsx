"use client";

import { useEffect, useRef, useState } from "react";

// Bottom-left account button (like other AI apps): opens a menu with Settings and Sign out.
// compact = just the round initial (desktop app rail); otherwise initial + email (phone sidebar).
export function AccountMenu({ email, onSettings, signOut, compact = false }: {
  email: string;
  onSettings: () => void;
  signOut: () => Promise<void> | void;
  compact?: boolean;
}) {
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

  const initial = (email.trim()[0] ?? "?").toUpperCase();
  const avatar = (
    <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand text-sm font-semibold text-on-brand">{initial}</span>
  );
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" title={compact ? "Account and settings" : undefined}
        aria-label={compact ? "Account and settings" : undefined}
        className={compact ? "rounded-full p-0.5 hover:ring-2 hover:ring-line-strong" : "flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-surface-200"}>
        {avatar}
        {!compact && <span className="min-w-0 flex-1 truncate text-sm">{email}</span>}
      </button>
      {open && (
        <div role="menu" className={`absolute bottom-full z-40 mb-2 w-60 rounded-2xl border border-line bg-composer p-1 shadow-menu ${compact ? "left-0" : "left-0 right-0 w-auto"}`}>
          <p className="truncate px-3 pb-1.5 pt-2 text-xs text-ink-subtle">{email}</p>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onSettings(); }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm hover:bg-surface-300">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden className="shrink-0"><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            Settings
          </button>
          <form action={signOut}>
            <button role="menuitem" className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm hover:bg-surface-300">
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden className="shrink-0"><path d="M6 3H3.5A1 1 0 0 0 2.5 4v8a1 1 0 0 0 1 1H6M10 5l3 3-3 3M13 8H6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
