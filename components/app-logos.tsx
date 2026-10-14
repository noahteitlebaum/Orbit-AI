// Small marks for the "Connect apps" menu: simple coloured tiles with a glyph (not the companies' logos).
const TILES: Record<string, { bg: string; fg?: string; glyph: string }> = {
  github: { bg: "#24292f", glyph: "GH" },
  "google-drive": { bg: "#1fa463", glyph: "D" },
  onedrive: { bg: "#0a64d6", glyph: "O" },
  outlook: { bg: "#0f6cbd", glyph: "✉" },
  "outlook-calendar": { bg: "#0f6cbd", glyph: "31" },
  gmail: { bg: "#d93025", glyph: "✉" },
  "google-calendar": { bg: "#1a73e8", glyph: "31" },
  notion: { bg: "#f7f6f3", fg: "#111", glyph: "N" },
  zotero: { bg: "#cc2936", glyph: "Z" },
  youtube: { bg: "#ff0033", glyph: "▶" },
};

export function AppLogo({ id, size = 32 }: { id: string; size?: number }) {
  const t = TILES[id] ?? { bg: "var(--surface-300)", glyph: id.slice(0, 1).toUpperCase() };
  return (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-lg font-semibold ring-1 ring-black/5"
      style={{ width: size, height: size, background: t.bg, color: t.fg ?? "#fff", fontSize: t.glyph.length > 1 ? size * 0.34 : size * 0.44 }}>
      {t.glyph}
    </span>
  );
}
