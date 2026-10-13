"use client";

import { useEffect, useRef, useState } from "react";
import { getModel, MODELS, type ProviderId } from "@/config/models";
import { ProviderLogo } from "./provider-logo";

// Typical message ≈ 3,000 tokens in (history + question) and 800 out. Prices are $ per 1M tokens.
function perMessage(inPrice: number, outPrice: number) {
  const usd = (3000 * inPrice + 800 * outPrice) / 1_000_000;
  return usd < 0.001 ? "<US$0.001" : `US$${usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

// Model picker that lives in the message box (like Gemini's "Flash ▾"). Opens upward as a card.
export function ModelMenu({ provider, value, onChange, disabled }: {
  provider: ProviderId;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const options = MODELS.filter(m=>m.enabled);
  const current = getModel(value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium text-ink-muted transition hover:bg-surface-300 hover:text-ink disabled:opacity-50 ${open ? "bg-surface-300 text-ink" : ""}`}
      >
        {current?.short ?? "Model"}
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div role="menu" className="model-menu absolute bottom-full right-0 z-40 mb-2 max-h-[65vh] overflow-y-auto w-72 origin-bottom-right rounded-2xl border border-line bg-composer p-1.5 shadow-menu">
          <div className="flex items-center gap-2 px-3 pb-1.5 pt-2 text-xs font-medium text-ink-subtle">
            <ProviderLogo provider={provider} size={14} />
            Choose a model
          </div>
          {options.map((m) => {
            const on = m.id === value;
            return (
              <button
                key={m.id}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-surface-300 ${on ? "bg-surface-200" : ""}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium text-ink"><ProviderLogo provider={m.provider} size={14} />{m.label}</span>
                  <span className="block truncate text-xs text-ink-subtle">{m.description}</span>
                  <span className="block text-[11px] tabular-nums text-ink-subtle">≈ {perMessage(m.inputPrice, m.outputPrice)} per typical message</span>
                </span>
                <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${on ? "bg-brand text-on-brand" : "border border-line-strong"}`}>
                  {on && (
                    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden>
                      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
