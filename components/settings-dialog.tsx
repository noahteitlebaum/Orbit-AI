"use client";

import { useEffect, useRef, useState } from "react";
import type { ProviderId } from "@/config/models";
import { ImportHistory } from "./import-history";
import { emptyProfile, LENGTHS, LIMITS, STYLES, type Memory, type Profile } from "@/lib/profile/personal";

// Settings: the student's profile (used by every AI app), saved memories they can see and delete,
// and a shortcut to each course's own instructions.
export type SettingsTab = "profile" | "memory" | "courses" | "import";
const LEVELS = ["", "1st year", "2nd year", "3rd year", "4th year", "5th year+", "Graduate (Master's)", "Graduate (PhD)", "Other"];

export function SettingsDialog({ open, tab: initialTab, onClose, email, appName, courses, onOpenCourse, memoryVersion, onImported }: {
  open: boolean;
  tab?: SettingsTab;
  onClose: () => void;
  email: string;
  appName: string;
  courses: { id: string; name: string; instructions: string }[];
  onOpenCourse: (id: string) => void;
  onImported?: (provider: ProviderId) => void; // chats were imported into this app: reload its list
  memoryVersion?: number; // bumps when the AI saves a memory, so an open list reloads
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<SettingsTab>("profile");
  const [profile, setProfile] = useState<Profile>(emptyProfile());
  const [saved, setSaved] = useState<Profile>(emptyProfile());
  const [memories, setMemories] = useState<Memory[]>([]);
  const [ready, setReady] = useState(true);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [newMemory, setNewMemory] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setTab(initialTab ?? "profile");
      setStatus(null);
      setConfirmClear(false);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await fetch("/api/profile").catch(() => null);
      const out = res?.ok ? ((await res.json()) as { profile: Profile; memories: Memory[]; ready: boolean }) : null;
      if (cancelled) return;
      setLoading(false);
      if (!out) return setStatus("Couldn't load your settings. Try again.");
      setProfile(out.profile);
      setSaved(out.profile);
      setMemories(out.memories);
      setReady(out.ready);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, memoryVersion]);

  async function save(next: Profile, note = "Saved.") {
    setStatus("Saving…");
    const res = await fetch("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }).catch(() => null);
    if (!res?.ok) return setStatus("Couldn't save. Try again.");
    const out = (await res.json()) as { profile: Profile };
    setProfile(out.profile);
    setSaved(out.profile);
    setStatus(note);
  }

  async function addMemory() {
    const content = newMemory.trim();
    if (!content) return;
    const res = await fetch("/api/memories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) }).catch(() => null);
    if (!res?.ok) {
      const err = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
      return setStatus(err?.error === "too_many" ? `You can keep up to ${LIMITS.memories} memories. Delete some first.` : "Couldn't save that memory.");
    }
    const { memory } = (await res.json()) as { memory: Memory };
    setMemories((m) => [memory, ...m]);
    setNewMemory("");
    setStatus(null);
  }

  async function forget(id: string) {
    const before = memories;
    setMemories((m) => m.filter((x) => x.id !== id));
    const res = await fetch(`/api/memories/${id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      setMemories(before);
      setStatus("Couldn't delete that memory.");
    }
  }

  async function forgetAll() {
    const res = await fetch("/api/memories", { method: "DELETE" }).catch(() => null);
    setConfirmClear(false);
    if (res?.ok) setMemories([]);
    else setStatus("Couldn't delete your memories.");
  }

  const dirty = JSON.stringify(profile) !== JSON.stringify(saved);
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => {
    setProfile((p) => ({ ...p, [k]: v }));
    setStatus(null);
  };
  const input = "mt-1.5 w-full rounded-xl border border-line-strong bg-surface-000 px-3.5 py-2.5 text-sm outline-none focus:border-brand";
  const label = "mt-4 block text-sm font-medium";
  const primary = "rounded-full bg-brand px-5 py-2 text-sm font-medium text-on-brand disabled:opacity-60";
  const secondary = "rounded-full border border-line-strong px-4 py-2 text-sm font-medium hover:bg-surface-300 disabled:opacity-60";

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto h-[min(90dvh,680px)] w-[min(94vw,720px)] rounded-3xl border border-line bg-composer p-0 text-ink shadow-menu backdrop:bg-black/50"
    >
      <div className="flex h-full flex-col sm:flex-row">
        <nav className="flex shrink-0 gap-1 border-b border-line p-3 sm:w-44 sm:flex-col sm:border-b-0 sm:border-r" aria-label="Settings sections">
          <h2 className="hidden px-3 pb-2 pt-1 text-lg font-medium sm:block">Settings</h2>
          {([["profile", "Profile"], ["memory", "Memory"], ["courses", "Courses"], ["import", "Import"]] as const).map(([key, text]) => (
            <button key={key} type="button" onClick={() => { setTab(key); setStatus(null); }} aria-current={tab === key ? "page" : undefined}
              className={`rounded-xl px-3 py-2 text-left text-sm ${tab === key ? "bg-surface-300 font-medium" : "text-ink-muted hover:bg-surface-200"}`}>
              {text}
            </button>
          ))}
          <button type="button" onClick={onClose} aria-label="Close settings" className="ml-auto rounded-xl px-3 py-2 text-sm text-ink-muted hover:bg-surface-200 sm:hidden">✕</button>
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {!ready && (
            <p className="mb-4 rounded-2xl bg-surface-100 p-3 text-sm text-warning">
              Settings aren&apos;t set up yet: run <code>supabase/migrations/0008_profile_memory.sql</code> in the Supabase SQL Editor.
            </p>
          )}

          {tab === "profile" && (
            <form onSubmit={(e) => { e.preventDefault(); save(profile); }}>
              <h3 className="text-base font-medium">Profile</h3>
              <p className="mt-1 text-sm text-ink-muted">Every AI app uses this to fit answers to you. Course instructions win if they say something different.</p>

              <div className="grid gap-x-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="pf-name" className={label}>What should the AI call you?</label>
                  <input id="pf-name" value={profile.display_name} onChange={(e) => set("display_name", e.target.value)} maxLength={LIMITS.display_name} placeholder="e.g. Noah" className={input} />
                </div>
                <div>
                  <label htmlFor="pf-level" className={label}>Year</label>
                  <select id="pf-level" value={LEVELS.includes(profile.level) ? profile.level : "Other"} onChange={(e) => set("level", e.target.value)} className={input}>
                    {LEVELS.map((l) => <option key={l} value={l}>{l || "Not set"}</option>)}
                  </select>
                </div>
              </div>
              <label htmlFor="pf-program" className={label}>Program</label>
              <input id="pf-program" value={profile.program} onChange={(e) => set("program", e.target.value)} maxLength={LIMITS.program} placeholder="e.g. BSc Computer Science, minor in Statistics" className={input} />

              <div className="grid gap-x-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="pf-style" className={label}>Explanation style</label>
                  <select id="pf-style" value={profile.style} onChange={(e) => set("style", e.target.value as Profile["style"])} className={input}>
                    {Object.entries(STYLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="pf-length" className={label}>Answer length</label>
                  <select id="pf-length" value={profile.length} onChange={(e) => set("length", e.target.value as Profile["length"])} className={input}>
                    {Object.entries(LENGTHS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
              </div>

              <label htmlFor="pf-about" className={label}>What should the AI know about you? <span className="font-normal text-ink-subtle">(optional)</span></label>
              <textarea id="pf-about" value={profile.about} onChange={(e) => set("about", e.target.value)} maxLength={LIMITS.about} rows={3}
                placeholder="e.g. I'm taking CS 2210 and STATS 2244 this term. Math isn't my strongest subject. I learn best with diagrams."
                className={`${input} resize-y leading-relaxed`} />
              <label htmlFor="pf-instr" className={label}>How should it respond? <span className="font-normal text-ink-subtle">(optional)</span></label>
              <textarea id="pf-instr" value={profile.instructions} onChange={(e) => set("instructions", e.target.value)} maxLength={LIMITS.instructions} rows={3}
                placeholder="e.g. Use SI units. Show formulas in LaTeX. Don't give me full assignment solutions; give hints first."
                className={`${input} resize-y leading-relaxed`} />

              <div className="mt-5 flex items-center justify-end gap-3">
                {status && <span role="status" className="text-sm text-ink-muted">{status}</span>}
                <button type="submit" disabled={!dirty || loading || !ready} className={primary}>Save</button>
              </div>
            </form>
          )}

          {tab === "memory" && (
            <div>
              <h3 className="text-base font-medium">Memory</h3>
              <p className="mt-1 text-sm text-ink-muted">
                Short notes the AI keeps between chats, like your courses or how you like things explained. You can see and delete every one.
              </p>
              <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-line p-3.5">
                <input type="checkbox" checked={profile.memory_enabled} disabled={loading || !ready}
                  onChange={(e) => save({ ...saved, memory_enabled: e.target.checked }, e.target.checked ? "Memory is on." : "Memory is off.")}
                  className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
                <span>
                  <span className="block text-sm font-medium">Use memory</span>
                  <span className="block text-xs text-ink-subtle">
                    The AI uses relevant saved notes and can save new ones when you tell it something lasting.
                    When semantic search is enabled, earlier chat excerpts and saved notes are sent to OpenAI to find relevant context.
                    Turning this off stops saved-memory use and semantic search and removes search vectors; your saved notes and chat history remain.
                  </span>
                </span>
              </label>

              <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); addMemory(); }}>
                <input value={newMemory} onChange={(e) => setNewMemory(e.target.value)} maxLength={LIMITS.memory} placeholder="Add a memory, e.g. I'm in Engineering 1st year" aria-label="New memory"
                  className="min-w-0 flex-1 rounded-xl border border-line-strong bg-surface-000 px-3.5 py-2 text-sm outline-none focus:border-brand" />
                <button type="submit" disabled={!newMemory.trim() || !ready} className={secondary}>Add</button>
              </form>
              {status && <p role="status" className="mt-2 text-sm text-ink-muted">{status}</p>}

              <ul className="mt-4 divide-y divide-line rounded-2xl border border-line" aria-label="Saved memories">
                {memories.length === 0 && <li className="p-4 text-sm text-ink-subtle">{loading ? "Loading…" : "No memories yet."}</li>}
                {memories.map((m) => (
                  <li key={m.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm">{m.content}</p>
                      <p className="mt-0.5 text-xs text-ink-subtle">
                        {m.source === "ai" ? "Saved by the AI" : "Added by you"} · {new Date(m.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                      </p>
                    </div>
                    <button type="button" onClick={() => forget(m.id)} aria-label={`Delete memory: ${m.content}`}
                      className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium text-ink-muted hover:bg-surface-300 hover:text-danger">Delete</button>
                  </li>
                ))}
              </ul>
              {memories.length > 0 && (
                <div className="mt-3 flex justify-end gap-2">
                  {confirmClear ? (
                    <>
                      <span className="self-center text-sm text-ink-muted">Delete all {memories.length}?</span>
                      <button type="button" onClick={() => setConfirmClear(false)} className={secondary}>Cancel</button>
                      <button type="button" onClick={forgetAll} className="rounded-full bg-danger px-4 py-2 text-sm font-medium text-white">Delete all</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirmClear(true)} className="text-sm text-ink-muted underline underline-offset-[3px] hover:text-danger">Delete all memories</button>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === "import" && <ImportHistory onImported={(p) => onImported?.(p)} />}

          {tab === "courses" && (
            <div>
              <h3 className="text-base font-medium">Course instructions</h3>
              <p className="mt-1 text-sm text-ink-muted">Each course has its own instructions for every chat inside it (in {appName} only), on top of your profile.</p>
              <ul className="mt-4 divide-y divide-line rounded-2xl border border-line">
                {courses.length === 0 && <li className="p-4 text-sm text-ink-subtle">No courses in {appName} yet. Create one with &quot;New course&quot; in the sidebar.</li>}
                {courses.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="truncate text-xs text-ink-subtle">{c.instructions.trim() || "No instructions"}</p>
                    </div>
                    <button type="button" onClick={() => onOpenCourse(c.id)} className="shrink-0 rounded-full border border-line-strong px-3 py-1 text-xs font-medium hover:bg-surface-300">Edit</button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-8 border-t border-line pt-3 text-xs text-ink-subtle">Signed in as {email}</p>
        </div>
      </div>
    </dialog>
  );
}
