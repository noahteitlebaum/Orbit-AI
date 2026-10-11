"use client";

import { useEffect, useRef, useState } from "react";
import type { UploadedFile } from "@/lib/files/upload-client";
import { ACCEPT_ATTR, fileNote } from "@/lib/files/upload-client";
import { FileChip } from "./file-chip";

// Create / edit a course: name, instructions every chat in it follows, and reusable course files
// (lectures, slides, assignment specs) that answers can quote with page references.
export function ProjectDialog({ open, initial, files, onClose, onSave, onDelete, onUpload, onDeleteFile, uploading }: {
  open: boolean;
  initial?: { name: string; instructions: string };
  files?: UploadedFile[];
  uploading?: string[]; // names currently uploading
  onClose: () => void;
  onSave: (v: { name: string; instructions: string }) => Promise<void>;
  onDelete?: () => Promise<void>;
  onUpload?: (files: File[]) => void;
  onDeleteFile?: (id: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setName(initial?.name ?? "");
      setInstructions(initial?.instructions ?? "");
      setConfirmDelete(false);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open, initial]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto max-h-[90dvh] w-[min(92vw,560px)] rounded-3xl border border-line bg-composer p-0 text-ink shadow-menu backdrop:bg-black/50"
    >
      <form
        className="p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setSaving(true);
          await onSave({ name: name.trim(), instructions });
          setSaving(false);
        }}
      >
        <h2 className="text-lg font-medium">{initial ? "Course settings" : "New course"}</h2>
        <p className="mt-1 text-sm text-ink-muted">Keep a course together: its files and instructions work in every chat inside it, in this app only.</p>
        <label htmlFor="project-name" className="mt-5 block text-sm font-medium">Name</label>
        <input id="project-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder="e.g. STATS 2244"
          className="mt-1.5 w-full rounded-xl border border-line-strong bg-surface-000 px-3.5 py-2.5 outline-none focus:border-brand" />
        <label htmlFor="project-instructions" className="mt-4 block text-sm font-medium">Instructions <span className="font-normal text-ink-subtle">(optional)</span></label>
        <textarea id="project-instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={8000} rows={4}
          placeholder="e.g. I'm in second-year stats. Use the course notation and explain step by step."
          className="mt-1.5 w-full resize-y rounded-xl border border-line-strong bg-surface-000 px-3.5 py-2.5 text-sm leading-relaxed outline-none focus:border-brand" />

        {initial && onUpload && (
          <div className="mt-5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Course files</p>
              <button type="button" onClick={() => fileInput.current?.click()} className="rounded-full border border-line-strong px-3 py-1 text-xs font-medium hover:bg-surface-300">
                + Add files
              </button>
              <input ref={fileInput} type="file" multiple accept={ACCEPT_ATTR} hidden
                onChange={(e) => { onUpload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
            </div>
            <p className="mt-1 text-xs text-ink-subtle">Lecture slides, readings, assignment specs. Answers cite them by page.</p>
            <div className="mt-2 flex max-h-48 flex-col gap-1.5 overflow-y-auto">
              {(uploading ?? []).map((n) => <FileChip key={`u-${n}`} name={n} state="uploading" />)}
              {(files ?? []).map((f) => (
                <FileChip key={f.id} name={f.name} kind={f.kind} state={f.status} detail={fileNote(f)}
                  onRemove={onDeleteFile ? () => onDeleteFile(f.id) : undefined} wide />
              ))}
              {!files?.length && !uploading?.length && <p className="rounded-xl bg-surface-200 px-3 py-3 text-center text-xs text-ink-subtle">No files yet.</p>}
            </div>
          </div>
        )}

        <div className="mt-6 flex items-center gap-2">
          {onDelete && (
            <button type="button" onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
              className={`rounded-full px-4 py-2 text-sm text-danger hover:bg-danger-surface ${confirmDelete ? "bg-danger-surface font-medium" : ""}`}>
              {confirmDelete ? "Delete course and its files?" : "Delete course"}
            </button>
          )}
          <button type="button" onClick={onClose} className="ml-auto rounded-full px-4 py-2 text-sm font-medium hover:bg-surface-300">Cancel</button>
          <button type="submit" disabled={saving || !name.trim()} className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-on-brand transition hover:bg-brand-strong disabled:opacity-40">
            {saving ? "Saving…" : initial ? "Save" : "Create course"}
          </button>
        </div>
        {!initial && <p className="mt-3 text-xs text-ink-subtle">You can add course files after creating it.</p>}
      </form>
    </dialog>
  );
}
