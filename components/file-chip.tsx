// One uploaded file: name, type, and whether we could read it.
export function FileChip({ name, kind, state, detail, onRemove, wide }: {
  name: string;
  kind?: "document" | "image" | string;
  state: "uploading" | "ready" | "failed" | "needs_ocr" | string;
  detail?: string;
  onRemove?: () => void;
  wide?: boolean;
}) {
  const bad = state === "failed"; // scanned (needs_ocr) files are read as page images, so they're fine
  const ext = name.split(".").pop()?.toUpperCase().slice(0, 4) ?? "";
  return (
    <div title={detail ?? name}
      className={`flex min-w-0 items-center gap-2.5 rounded-xl border px-2.5 py-1.5 text-left ${bad ? "border-danger/40 bg-danger-surface" : "border-line bg-surface-200"} ${wide ? "w-full" : "max-w-64"}`}>
      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[10px] font-bold ${kind === "image" ? "bg-surface-300 text-ink-muted" : "bg-brand text-on-brand"}`}>
        {state === "uploading" ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : kind === "image" ? "IMG" : ext}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-ink">{name}</span>
        <span className={`block truncate text-[11px] ${bad ? "text-danger" : "text-ink-subtle"}`}>
          {state === "uploading" ? "Uploading…" : state === "needs_ocr" ? detail ?? "Scanned · read as page images" : state === "failed" ? detail ?? "Couldn't read this file" : detail ?? (kind === "image" ? "Image" : "Ready")}
        </span>
      </span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${name}`} className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-subtle hover:bg-surface-300 hover:text-ink">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      )}
    </div>
  );
}
