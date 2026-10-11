"use client";

// File actions taken while writing a reply. Changes wait here for the student's Apply / Skip.
export type ActivityStatus = "running" | "waiting" | "ok" | "declined" | "error";
export type Activity = {
  id: string;
  name: string;
  label: string;
  status: ActivityStatus;
  detail?: string; // what a change will do (from the helper's dry run), or why it failed
  preview?: { old?: string; next?: string };
};

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)}\n…` : s);

export function previewFor(name: string, args: Record<string, unknown>): Activity["preview"] {
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  if (name === "edit_file") return { old: clip(s("old_text"), 1500), next: clip(s("new_text"), 1500) };
  if (name === "write_file") return { next: clip(s("content"), 2500) };
  return undefined;
}

const STATUS_TEXT: Record<ActivityStatus, string> = { running: "Working…", waiting: "Needs your OK", ok: "Done", declined: "Skipped", error: "Failed" };

export function FolderActivity({ items, onDecide }: { items: Activity[]; onDecide: (id: string, approve: boolean) => void }) {
  return (
    <ul className="mt-3 space-y-1.5" aria-label="File actions">
      {items.map((a) =>
        a.status === "waiting" ? (
          <li key={a.id} className="rounded-2xl border border-line-strong bg-surface-100 p-3">
            <p className="text-sm font-medium">{a.label}</p>
            {a.detail && <p className="mt-0.5 text-xs text-ink-muted">{a.detail}</p>}
            {a.preview?.old !== undefined && (
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-danger-surface px-3 py-2 text-xs text-danger"><span className="sr-only">Remove: </span>{a.preview.old}</pre>
            )}
            {a.preview?.next !== undefined && (
              <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-xl bg-surface-000 px-3 py-2 text-xs"><span className="sr-only">New text: </span>{a.preview.next || "(empty)"}</pre>
            )}
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => onDecide(a.id, true)} className="rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-on-brand">Apply</button>
              <button type="button" onClick={() => onDecide(a.id, false)} className="rounded-full border border-line-strong px-4 py-1.5 text-sm font-medium hover:bg-surface-300">Skip</button>
            </div>
          </li>
        ) : (
          <li key={a.id} className="flex items-center gap-2 text-xs text-ink-muted">
            <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${a.status === "ok" ? "bg-success" : a.status === "error" ? "bg-danger" : a.status === "running" ? "animate-pulse bg-ice" : "bg-ink-subtle"}`} />
            <span className="min-w-0 truncate">{a.label}</span>
            <span className="shrink-0 text-ink-subtle">· {STATUS_TEXT[a.status]}</span>
            {a.status === "error" && a.detail && <span className="min-w-0 truncate text-danger" title={a.detail}>— {a.detail}</span>}
          </li>
        ),
      )}
    </ul>
  );
}
