"use client";

import { useEffect, useRef, useState } from "react";
import { folderAccessSupported, pickFolder, type ApprovalMode, type FolderLink } from "@/lib/folder/browser-fs";

// Connect a folder: the browser's own folder picker, then its "Let this site edit files?" prompt. Nothing to install.
// Once connected: change folder, choose how changes are approved, or disconnect.
export function FolderDialog({ open, link, needsPermission, onClose, onLinked, onReconnect, onDisconnect, approvalMode, onApprovalMode }: {
  open: boolean;
  link: FolderLink | null;
  needsPermission: boolean; // remembered folder, but the browser wants the student to allow it again
  onClose: () => void;
  onLinked: (link: FolderLink) => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  approvalMode: ApprovalMode;
  onApprovalMode: (mode: ApprovalMode) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [supported, setSupported] = useState<boolean | null>(null); // known only in the browser
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(folderAccessSupported());
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  async function choose() {
    setPicking(true);
    const next = await pickFolder();
    setPicking(false);
    if (next) onLinked(next);
  }

  const primary = "inline-flex items-center justify-center rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-on-brand disabled:opacity-60";
  const secondary = "rounded-full border border-line-strong px-4 py-2 text-sm font-medium hover:bg-surface-300 disabled:opacity-60";

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto max-h-[90dvh] w-[min(92vw,500px)] rounded-3xl border border-line bg-composer p-0 text-ink shadow-menu backdrop:bg-black/50"
    >
      <div className="p-6">
        {link ? (
          <>
            <h2 className="text-lg font-medium">Folder: {link.name}</h2>
            {needsPermission ? (
              <div className="mt-3 rounded-2xl bg-surface-100 p-4 text-sm">
                <p className="text-ink-muted">Your browser needs you to allow access to this folder again.</p>
                <button type="button" onClick={onReconnect} className={`${primary} mt-3`}>Allow access</button>
              </div>
            ) : (
              <p className="mt-2 text-sm text-ink-muted">The AI can read files in this folder and change them when you ask.</p>
            )}

            <fieldset className="mt-5">
              <legend className="text-sm font-medium">When the AI wants to change files</legend>
              {([
                ["ask", "Ask me every time", "You see each change and click Apply or Skip."],
                ["edits", "Don't ask for edits", "Edits, new files and moves happen straight away. Deletes still ask."],
              ] as const).map(([value, label, hint]) => (
                <label key={value} className={`mt-2 flex cursor-pointer gap-3 rounded-xl border px-3 py-2.5 ${approvalMode === value ? "border-brand bg-surface-100" : "border-line hover:bg-surface-100"}`}>
                  <input type="radio" name="approval" value={value} checked={approvalMode === value} onChange={() => onApprovalMode(value)} className="mt-1 accent-[var(--brand)]" />
                  <span>
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="block text-xs text-ink-subtle">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={onDisconnect} className={secondary}>Disconnect</button>
              <button type="button" onClick={choose} disabled={picking} className={secondary}>Change folder</button>
              <button type="button" onClick={onClose} className={primary}>Done</button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-lg font-medium">Connect a folder</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Let the AI read and edit files in one folder on your computer. Your browser will ask you to allow it.
            </p>
            {supported === false && (
              <p className="mt-4 rounded-2xl bg-surface-100 p-4 text-sm text-ink-muted">Folder access needs Chrome or Edge on a computer.</p>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm font-medium text-ink-muted hover:bg-surface-300">Cancel</button>
              <button type="button" onClick={choose} disabled={!supported || picking} className={primary}>{picking ? "Choosing…" : "Choose folder"}</button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
