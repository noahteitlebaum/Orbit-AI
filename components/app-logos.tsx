"use client";

import { useState } from "react";

// App marks for plugins. If the team drops an app's official logo in public/plugins/<id>.svg (e.g. github.svg,
// gmail.svg — from each company's brand/press page), that is shown; otherwise a simple coloured glyph.
const TILES: Record<string, { color: string; glyph: string }> = {
  github: { color: "#24292f", glyph: "GH" },
  "google-drive": { color: "#1fa463", glyph: "D" },
  onedrive: { color: "#0a64d6", glyph: "O" },
  outlook: { color: "#0f6cbd", glyph: "✉" },
  "outlook-calendar": { color: "#0f6cbd", glyph: "31" },
  gmail: { color: "#d93025", glyph: "✉" },
  "google-calendar": { color: "#1a73e8", glyph: "31" },
  notion: { color: "#111111", glyph: "N" },
  zotero: { color: "#cc2936", glyph: "Z" },
  youtube: { color: "#ff0033", glyph: "▶" },
  wikipedia: { color: "#202122", glyph: "W" },
  arxiv: { color: "#b31b1b", glyph: "χ" },
  "semantic-scholar": { color: "#1857b6", glyph: "S2" },
  crossref: { color: "#3eb1c8", glyph: "CR" },
  wolfram: { color: "#dd1100", glyph: "✳" },
};
const missing = new Set<string>(); // logo files that aren't there (asked once per page load)

/** framed = white rounded tile with a border (Plugins page); otherwise a solid coloured tile (menus). */
export function AppLogo({ id, size = 32, framed = false }: { id: string; size?: number; framed?: boolean }) {
  const [failed, setFailed] = useState(missing.has(id));
  const t = TILES[id] ?? { color: "var(--ink-muted)", glyph: id.slice(0, 1).toUpperCase() };
  const radius = framed ? size * 0.26 : size * 0.25;
  const inner = Math.round(size * (framed ? 0.56 : 0.62));
  if (!failed) {
    return (
      <span aria-hidden className={`grid shrink-0 place-items-center ${framed ? "border border-line bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06)]" : "bg-white ring-1 ring-black/5"}`}
        style={{ width: size, height: size, borderRadius: radius }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- small local logo, may be svg or missing */}
        <img src={`/plugins/${id}.svg`} alt="" width={inner} height={inner} style={{ width: inner, height: inner, objectFit: "contain" }}
          onError={() => { missing.add(id); setFailed(true); }} />
      </span>
    );
  }
  return framed ? (
    <span aria-hidden className="grid shrink-0 place-items-center border border-line bg-white font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
      style={{ width: size, height: size, borderRadius: radius, color: t.color, fontSize: t.glyph.length > 1 ? size * 0.32 : size * 0.42 }}>
      {t.glyph}
    </span>
  ) : (
    <span aria-hidden className="grid shrink-0 place-items-center font-semibold text-white ring-1 ring-black/5"
      style={{ width: size, height: size, borderRadius: radius, background: t.color, fontSize: t.glyph.length > 1 ? size * 0.34 : size * 0.44 }}>
      {t.glyph}
    </span>
  );
}
