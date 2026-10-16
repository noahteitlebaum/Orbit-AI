"use client";

import { useEffect, useRef, useState } from "react";
import { AppLogo } from "./app-logos";

export type StudyMode = "chat" | "explain" | "quiz" | "hints";
export const MODE_LABELS: Record<StudyMode, { label: string; hint: string }> = {
  chat: { label: "Chat", hint: "Normal answers" },
  explain: { label: "Explain", hint: "Step by step, then a check question" },
  quiz: { label: "Quiz me", hint: "One question at a time, with a score" },
  hints: { label: "Hints only", hint: "Nudges, never the full answer" },
};

// "+" menu in the message box: upload files, connect a folder, create an image, pick a study mode, limit answers to course files.
export type ConnectedApp = { id: string; name: string; hint: string; onPick: () => void; group: "Files" | "Mail & calendar" | "Notes & research"; setup?: string };

export function ToolsMenu(p: {
  onUpload: () => void;
  cloud?: ConnectedApp[]; // GitHub, Google Drive, OneDrive, mail, calendars, Notion, Zotero, YouTube
  onManageApps?: () => void; // open the Plugins page
  plugins?: { id: string; name: string; enabled: boolean }[]; // installed plugins the AI can use (switch per student)
  onTogglePlugin?: (id: string, on: boolean) => void;
  imageLabel: string | null; // null = this app can't make images
  imageMode: boolean;
  onImageMode: (on: boolean) => void;
  mode: StudyMode;
  onMode: (m: StudyMode) => void;
  courseOnly: boolean;
  onCourseOnly: (on: boolean) => void;
  web?: boolean;               // search the web for this chat's questions
  onWeb?: (on: boolean) => void;
  folderName?: string | null; // connected folder
  folderOffline?: boolean;    // remembered folder, but the browser wants permission again
  onFolder?: () => void;      // open the connect / folder dialog; omitted = this app has no folder access
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"main" | "apps" | "plugins">("main");
  // Open upward when the box is low on the screen (in a chat), downward when it's high (empty chat), and never off-screen.
  const [place, setPlace] = useState<{ up: boolean; max: number }>({ up: true, max: 560 });
  function toggleOpen() {
    const r = root.current?.getBoundingClientRect();
    if (r) {
      const above = r.top - 16, below = window.innerHeight - r.bottom - 16;
      const up = above >= Math.min(480, below) || above >= 420;
      setPlace({ up, max: Math.max(220, Math.min(560, up ? above : below)) });
    }
    setOpen((o) => !o);
    setView("main");
  }
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-surface-300 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";
  const icon = "grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-200";

  return (
    <div ref={root} className="relative flex items-center gap-1">
      <button type="button" onClick={toggleOpen} disabled={p.disabled} aria-haspopup="menu" aria-expanded={open} aria-label="Tools"
        className={`grid h-9 w-9 place-items-center rounded-full text-ink-muted transition hover:bg-surface-300 hover:text-ink disabled:opacity-50 ${open ? "bg-surface-300 text-ink" : ""}`}>
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden className={`transition-transform ${open ? "rotate-45" : ""}`}>
          <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      {p.folderName && p.onFolder && (
        <button type="button" onClick={p.onFolder} title={p.folderOffline ? "Allow folder access again" : "Folder settings"}
          className="flex max-w-[11rem] items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-300 py-1 pl-2.5 pr-2.5 text-xs font-medium text-ink">
          <FolderIcon />
          <span className="truncate">{p.folderName}</span>
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.folderOffline ? "bg-warning" : "bg-success"}`} />
        </button>
      )}
      {p.imageMode && <Chip onClear={() => p.onImageMode(false)} label="Image" icon={<ImageIcon />} />}
      {p.mode !== "chat" && <Chip onClear={() => p.onMode("chat")} label={MODE_LABELS[p.mode].label} icon={<CapIcon />} />}
      {p.courseOnly && <Chip onClear={() => p.onCourseOnly(false)} label="My files only" icon={<BookIcon />} />}
      {p.web && p.onWeb && <Chip onClear={() => p.onWeb!(false)} label="Web" icon={<GlobeIcon />} />}

      {open && (
        <div role="menu" style={{ maxHeight: place.max }} className={`model-menu absolute left-0 z-40 w-80 overflow-y-auto rounded-2xl ${place.up ? "bottom-full mb-2 origin-bottom-left" : "top-full mt-2 origin-top-left"} border border-line bg-composer p-1.5 shadow-menu`}>
          {view === "plugins" ? (
            <>
              <div className="flex items-center gap-1 px-1 pb-1">
                <button type="button" onClick={() => setView("main")} aria-label="Back" className="grid h-8 w-8 place-items-center rounded-lg text-ink-muted hover:bg-surface-300">‹</button>
                <p className="text-sm font-medium">Plugins</p>
                {p.onManageApps && <button type="button" onClick={() => { p.onManageApps!(); setOpen(false); }} className="ml-auto rounded-full px-2.5 py-1 text-xs font-medium text-ink-muted hover:bg-surface-300 hover:text-ink">Browse</button>}
              </div>
              {(p.plugins ?? []).length === 0 && <p className="px-3 py-2 text-sm text-ink-subtle">No plugins installed yet.</p>}
              {(p.plugins ?? []).map((pl) => (
                <button key={pl.id} type="button" role="menuitemcheckbox" aria-checked={pl.enabled} className={item} onClick={() => p.onTogglePlugin?.(pl.id, !pl.enabled)}>
                  <AppLogo id={pl.id} />
                  <span className="min-w-0 flex-1 text-sm font-medium">{pl.name}</span>
                  <Toggle on={pl.enabled} />
                </button>
              ))}
              <p className="px-3 pb-1 pt-2 text-[11px] text-ink-subtle">The AI uses switched-on plugins when they help. Type @ to pick one for a message.</p>
            </>
          ) : view === "apps" ? (
            <>
              <div className="flex items-center gap-1 px-1 pb-1">
                <button type="button" onClick={() => setView("main")} aria-label="Back" className="grid h-8 w-8 place-items-center rounded-lg text-ink-muted hover:bg-surface-300">‹</button>
                <p className="text-sm font-medium">Add from apps</p>
                {p.onManageApps ? (
                  <button type="button" onClick={() => { p.onManageApps!(); setOpen(false); }} className="ml-auto rounded-full px-2.5 py-1 text-xs font-medium text-ink-muted hover:bg-surface-300 hover:text-ink">Manage</button>
                ) : <span className="ml-auto pr-2 text-[11px] text-ink-subtle">read-only</span>}
              </div>
              {(["Files", "Mail & calendar", "Notes & research"] as const).map((g) => {
                const apps = p.cloud!.filter((c) => c.group === g);
                return apps.length ? (
                  <div key={g}>
                    <p className="px-3 pb-1 pt-2 text-xs font-medium text-ink-subtle">{g}</p>
                    {apps.map((c) => (
                      <button key={c.id} type="button" role="menuitem" className={item} disabled={Boolean(c.setup)} title={c.setup}
                        onClick={() => { c.onPick(); setOpen(false); }}>
                        <AppLogo id={c.id} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{c.name}</span>
                          <span className="block truncate text-xs text-ink-subtle">{c.setup ? "Not set up on this server" : c.hint}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null;
              })}
            </>
          ) : (<>
          <button type="button" role="menuitem" className={item} onClick={() => { p.onUpload(); setOpen(false); }}>
            <span className={icon}><ClipIcon /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Add files</span>
              <span className="block truncate text-xs text-ink-subtle">PDF, Word, PowerPoint, Excel, code, images…</span>
            </span>
          </button>
          {p.plugins && (
            <button type="button" role="menuitem" aria-haspopup="menu" className={item} onClick={() => setView("plugins")}>
              <span className={icon}><PlugIcon /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Plugins</span>
                <span className="block truncate text-xs text-ink-subtle">{p.plugins.length ? `${p.plugins.filter((x) => x.enabled).length} of ${p.plugins.length} on · type @ to pick one` : "Let the AI use your apps"}</span>
              </span>
              <span aria-hidden className="text-ink-subtle">›</span>
            </button>
          )}
          {!!p.cloud?.length && (
            <button type="button" role="menuitem" aria-haspopup="menu" className={item} onClick={() => setView("apps")}>
              <span className={icon}><AppsIcon /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Add from apps</span>
                <span className="block truncate text-xs text-ink-subtle">GitHub, Drive, OneDrive, email, Notion, Zotero…</span>
              </span>
              <span aria-hidden className="text-ink-subtle">›</span>
            </button>
          )}
          {p.onFolder && (
            <button type="button" role="menuitem" className={item} onClick={() => { p.onFolder!(); setOpen(false); }}>
              <span className={icon}><FolderIcon /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{p.folderName ? `Folder: ${p.folderName}` : "Connect a folder"}</span>
                <span className="block truncate text-xs text-ink-subtle">{p.folderName ? (p.folderOffline ? "Click to allow access again" : "Read and edit files, with your approval") : "Let the AI read and edit files on your computer"}</span>
              </span>
            </button>
          )}
          <button type="button" role="menuitemcheckbox" aria-checked={p.imageMode} disabled={!p.imageLabel} className={item}
            onClick={() => { p.onImageMode(!p.imageMode); setOpen(false); }}>
            <span className={icon}><ImageIcon /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Create image</span>
              <span className="block truncate text-xs text-ink-subtle">{p.imageLabel ?? "Not available in this app"}</span>
            </span>
          </button>
          {p.onWeb && (
            <button type="button" role="menuitemcheckbox" aria-checked={Boolean(p.web)} className={item}
              onClick={() => { p.onWeb!(!p.web); setOpen(false); }}>
              <span className={icon}><GlobeIcon /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Search the web</span>
                <span className="block truncate text-xs text-ink-subtle">Current info with links · about 1¢ per search</span>
              </span>
              <Toggle on={Boolean(p.web)} />
            </button>
          )}
          <button type="button" role="menuitemcheckbox" aria-checked={p.courseOnly} className={item}
            onClick={() => { p.onCourseOnly(!p.courseOnly); setOpen(false); }}>
            <span className={icon}><BookIcon /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Only use my course material</span>
              <span className="block truncate text-xs text-ink-subtle">Answers come from your files, with page references</span>
            </span>
            <Toggle on={p.courseOnly} />
          </button>

          <p className="px-3 pb-1 pt-2.5 text-xs font-medium text-ink-subtle">Study mode</p>
          <div className="grid grid-cols-2 gap-1 px-1 pb-1">
            {(Object.keys(MODE_LABELS) as StudyMode[]).map((m) => (
              <button key={m} type="button" role="menuitemradio" aria-checked={p.mode === m} title={MODE_LABELS[m].hint}
                onClick={() => { p.onMode(m); setOpen(false); }}
                className={`rounded-xl px-3 py-2 text-left text-sm transition ${p.mode === m ? "bg-surface-300 font-medium" : "hover:bg-surface-200"}`}>
                {MODE_LABELS[m].label}
                <span className="block truncate text-[11px] font-normal text-ink-subtle">{MODE_LABELS[m].hint}</span>
              </button>
            ))}
          </div>
          </>)}
        </div>
      )}
    </div>
  );
}

function Chip({ label, icon, onClear }: { label: string; icon: React.ReactNode; onClear: () => void }) {
  return (
    <button type="button" onClick={onClear} aria-label={`Turn off ${label}`}
      className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-300 py-1 pl-2.5 pr-2 text-xs font-medium text-ink">
      {icon} {label} <span aria-hidden className="text-ink-subtle">✕</span>
    </button>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`relative h-5 w-9 shrink-0 rounded-full transition ${on ? "bg-brand" : "bg-surface-300"}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface-000 shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </span>
  );
}

export function ClipIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      <path d="M10.5 4.5l-5 5a1.5 1.5 0 0 0 2.1 2.1l5.3-5.3a3 3 0 0 0-4.2-4.2L3.3 7.5a4.5 4.5 0 0 0 6.4 6.4l4-4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function ImageIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      <rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6" cy="6.3" r="1.2" fill="currentColor" />
      <path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}
function CapIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      <path d="M1.5 6L8 3l6.5 3L8 9zM4 7.3v3.2c1 1 2.5 1.5 4 1.5s3-.5 4-1.5V7.3M14.5 6v4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}
function BookIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      <path d="M8 4c-1.5-1-3.5-1.3-5.5-1v9.5c2-.3 4 0 5.5 1 1.5-1 3.5-1.3 5.5-1V3c-2-.3-4 0-5.5 1zm0 0v9.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}
function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.5 1.5h4.9A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}
function GlobeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function PlugIcon() {
  return <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden><path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function AppsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      {[[2.5, 2.5], [9, 2.5], [2.5, 9], [9, 9]].map(([x, y]) => <rect key={`${x}${y}`} x={x} y={y} width="4.5" height="4.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />)}
    </svg>
  );
}
