"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppLogo } from "./app-logos";
import { PluginConnect } from "./plugin-connect";
import { PLUGINS, type PluginId, type PluginInfo } from "@/lib/plugins/catalog";
import { connectPopup, disconnect, loadServerReady, pluginAccount, pluginConfigured, pluginConnected, usesPopup } from "@/lib/plugins/connect";
import { githubSignInConfigured } from "@/lib/connectors/github";
import { connectGitHub, githubConnectReady, githubConnectReadyNow, githubInstallUrl } from "@/lib/connectors/github-connect";
import { parseSkillMd, SKILL_LIMITS, type Skill } from "@/lib/plugins/skills";
import { allSkills, type useExtensions } from "@/lib/plugins/state";

// Plugins & Skills, laid out like ChatGPT's: Plugins | Skills tabs, search, Installed, Public / Personal, then
// Popular and category lists with a + to install. Installing asks to connect the app (its own sign-in screen).
type Ext = ReturnType<typeof useExtensions>;
type Status = "yes" | "no" | "limited";
type View = { kind: "home" } | { kind: "section"; title: string };

const SECTIONS: { title: string; filter: (p: PluginInfo) => boolean }[] = [
  { title: "Popular", filter: (p) => Boolean(p.popular) },
  { title: "Research", filter: (p) => p.category === "Research" },
  { title: "Developer", filter: (p) => p.category === "Developer" },
  { title: "Files", filter: (p) => p.category === "Files" },
  { title: "Mail & calendar", filter: (p) => p.category === "Mail & calendar" },
  { title: "Notes & library", filter: (p) => p.category === "Notes & research" },
];
const SHOWN = new Set(["Popular", "Research", "Developer", "Files", "Mail & calendar", "Notes & library"]);

export function PluginsPage({ ext, appName, onTry, initialTab = "plugins" }: { ext: Ext; appName: string; onTry: (prompt: string) => void; initialTab?: "plugins" | "skills" }) {
  const [tab, setTab] = useState<"plugins" | "skills">(initialTab);
  const [scope, setScope] = useState<"public" | "personal">("public");
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>({ kind: "home" });
  const [open, setOpen] = useState<PluginId | null>(null);
  const [skillOpen, setSkillOpen] = useState<Skill | "new" | null>(null);
  const [connections, setConnections] = useState(false);
  const [status, setStatus] = useState<Partial<Record<PluginId, Status>>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const upload = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    await Promise.all([loadServerReady(), githubConnectReady()]);
    const out: Partial<Record<PluginId, Status>> = {};
    for (const p of PLUGINS) out[p.id] = await pluginConnected(p);
    setStatus(out);
  };
  useEffect(() => {
    void refresh(); // eslint-disable-line react-hooks/set-state-in-effect -- sets state after awaiting sign-in checks
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const installed = new Set(ext.ext.plugins.map((p) => p.id));
  const skillOn = new Set(ext.ext.skills.map((s) => s.id));
  const skills = allSkills(ext.ext);
  const match = (text: string) => text.toLowerCase().includes(q.trim().toLowerCase());
  const plugins = useMemo(() => PLUGINS.filter((p) => !q.trim() || match(`${p.name} ${p.tagline} ${p.category}`)), [q]); // eslint-disable-line react-hooks/exhaustive-deps

  // One click, like the apps: + installs and goes straight to the app's own sign-in page (no extra steps).
  async function install(p: PluginInfo) {
    ext.installPlugin(p.id, true);
    // No awaiting before the pop-up opens, or the browser may block it.
    const signIn = p.auth === "github" ? githubSignInConfigured && githubConnectReadyNow() : usesPopup(p) && pluginConfigured(p);
    if (p.auth === "zotero") return setOpen(p.id); // needs a pasted key
    if (!signIn || status[p.id] === "yes") return setToast(`${p.name} installed`);
    try {
      if (p.auth === "github") await connectGitHub();
      else await connectPopup(p);
      await refresh();
      setToast(`${p.name} connected`);
    } catch {
      await refresh();
      setOpen(p.id); // sign-in was closed or failed: show the plugin with its Connect button
    }
  }

  function addSkillFile(f: File | undefined) {
    if (!f) return;
    void f.text().then((t) => {
      const s = parseSkillMd(t);
      if (!s) return setToast("That file isn't a skill (needs a name and instructions).");
      ext.saveSkill(s);
      setTab("skills");
      setScope("personal");
      setToast(`Added “${s.name}”`);
    });
  }

  const title = tab === "plugins" ? "Plugins" : "Skills";
  const subtitle = tab === "plugins"
    ? `Connect plugins to let ${appName} work across your tools`
    : `Teach ${appName} how you like things done. Skills are used automatically when they fit.`;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* top bar: tabs in the middle, settings + Add on the right */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-surface-000 px-4 py-3 md:grid md:grid-cols-[1fr_auto_1fr] md:px-6">
        <span className="hidden md:block" />
        <div className="flex rounded-full p-1" role="tablist" aria-label="Plugins and skills">
          {(["plugins", "skills"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setView({ kind: "home" }); setScope("public"); }}
              className={`rounded-full px-4 py-2 text-[15px] font-medium transition sm:px-5 ${tab === t ? "bg-surface-200 text-ink" : "text-ink-muted hover:text-ink"}`}>
              {t === "plugins" ? "Plugins" : "Skills"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 justify-self-end sm:gap-2">
          <button type="button" onClick={() => setConnections(true)} aria-label="Connections" title="Connections"
            className="grid h-10 w-10 place-items-center rounded-full text-ink-muted hover:bg-surface-200 hover:text-ink">
            <GearIcon />
          </button>
          <div className="relative">
            <button type="button" onClick={() => setAddOpen((o) => !o)} aria-haspopup="menu" aria-expanded={addOpen}
              className="flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-[15px] font-medium text-on-brand">
              Add <Chevron down />
            </button>
            {addOpen && (
              <div role="menu" className="model-menu absolute right-0 top-full z-20 mt-2 w-60 rounded-2xl border border-line bg-composer p-1.5 shadow-menu" onMouseLeave={() => setAddOpen(false)}>
                <MenuItem onClick={() => { setAddOpen(false); setTab("skills"); setSkillOpen("new"); }} title="Create skill" hint="Write instructions in your own words" />
                <MenuItem onClick={() => { setAddOpen(false); upload.current?.click(); }} title="Upload skill" hint="A SKILL.md or .txt file" />
              </div>
            )}
            <input ref={upload} type="file" accept=".md,.txt,text/markdown,text/plain" hidden onChange={(e) => { addSkillFile(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-5xl px-4 pb-16 md:px-6">
        {view.kind === "section" ? (
          <button type="button" onClick={() => setView({ kind: "home" })} className="mt-2 flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
            <Chevron left /> {title}
          </button>
        ) : null}
        <h1 className="mt-4 text-[32px] font-semibold tracking-tight">{view.kind === "section" ? view.title : title}</h1>
        {view.kind === "home" && <p className="mt-2 text-[17px] text-ink-muted">{subtitle}</p>}

        <label className="mt-7 flex items-center gap-3 rounded-full border border-line-strong bg-surface-000 px-5 py-3 focus-within:border-ink-subtle">
          <SearchIcon />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${tab}`} aria-label={`Search ${tab}`}
            className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-ink-subtle" />
        </label>

        {tab === "plugins" ? (
          <>
            {view.kind === "home" && !q && (
              <>
                <SectionHeader title="Installed" onMore={installed.size ? () => setView({ kind: "section", title: "Installed" }) : undefined} divider />
                {installed.size ? (
                  <div className="mt-4 flex flex-wrap gap-4">
                    {PLUGINS.filter((p) => installed.has(p.id)).map((p) => (
                      <button key={p.id} type="button" onClick={() => setOpen(p.id)} title={p.name} aria-label={`${p.name} settings`}
                        className="relative rounded-2xl transition hover:-translate-y-0.5">
                        <AppLogo id={p.id} size={64} framed />
                        <StatusDot s={ext.ext.plugins.find((x) => x.id === p.id)?.enabled === false ? "off" : status[p.id] === "no" ? "needs" : "on"} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-ink-subtle">Nothing installed yet. Tap + on a plugin below.</p>
                )}
                <Scope scope={scope} setScope={setScope} />
              </>
            )}
            {scope === "personal" && view.kind === "home" ? (
              <Empty title="No personal plugins" text="Plugins you build yourself will show up here. Orbit doesn't support custom plugins yet — use Skills to give the AI your own instructions." />
            ) : view.kind === "section" ? (
              <PluginGrid list={view.title === "Installed" ? plugins.filter((p) => installed.has(p.id)) : plugins.filter(SECTIONS.find((s) => s.title === view.title)!.filter)}
                installed={installed} status={status} onOpen={setOpen} onInstall={install} />
            ) : q ? (
              <>
                <SectionHeader title={`Results for “${q}”`} />
                {plugins.length ? <PluginGrid list={plugins} installed={installed} status={status} onOpen={setOpen} onInstall={install} /> : <Empty title="No plugins found" text="Try another name, like GitHub or Gmail." />}
              </>
            ) : (
              SECTIONS.filter((s) => SHOWN.has(s.title)).map((s) => {
                const list = plugins.filter(s.filter);
                return list.length ? (
                  <section key={s.title}>
                    <SectionHeader title={s.title} onMore={() => setView({ kind: "section", title: s.title })} />
                    <PluginGrid list={s.title === "Popular" ? list.slice(0, 6) : list} installed={installed} status={status} onOpen={setOpen} onInstall={install} />
                  </section>
                ) : null;
              })
            )}
          </>
        ) : (
          <>
            {!q && (
              <>
                <SectionHeader title="Installed" divider />
                {ext.ext.skills.length ? (
                  <div className="mt-4 flex flex-wrap gap-4">
                    {skills.filter((s) => skillOn.has(s.id)).map((s) => (
                      <button key={s.id} type="button" onClick={() => setSkillOpen(s)} title={s.name} aria-label={`${s.name} settings`} className="relative rounded-2xl transition hover:-translate-y-0.5">
                        <SkillTile skill={s} size={64} />
                        <StatusDot s={ext.ext.skills.find((x) => x.id === s.id)?.enabled ? "on" : "off"} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-ink-subtle">No skills installed yet.</p>
                )}
                <Scope scope={scope} setScope={setScope} />
              </>
            )}
            {(() => {
              const list = skills.filter((s) => (scope === "public" ? s.builtin : !s.builtin) && (!q || match(`${s.name} ${s.description}`)));
              return (
                <section>
                  <SectionHeader title={q ? `Results for “${q}”` : scope === "public" ? "Study skills" : "Your skills"} />
                  {scope === "personal" && !q && (
                    <button type="button" onClick={() => setSkillOpen("new")} className="mt-4 flex w-full items-center gap-4 rounded-2xl border border-dashed border-line-strong p-4 text-left hover:bg-surface-100">
                      <span className="grid h-14 w-14 place-items-center rounded-[15px] border border-line text-2xl text-ink-muted">+</span>
                      <span><span className="block text-[17px] font-medium">Create a skill</span><span className="block text-sm text-ink-muted">Say how you like answers, essays, notes or code done.</span></span>
                    </button>
                  )}
                  {list.length ? (
                    <div className="mt-2 grid grid-cols-1 gap-x-10 md:grid-cols-2">
                      {list.map((s) => (
                        <Row key={s.id} logo={<SkillTile skill={s} size={56} />} title={s.name} text={s.description || "Your skill"} onOpen={() => setSkillOpen(s)}
                          added={skillOn.has(s.id)} onAdd={() => { ext.installSkill(s.id, true); setToast(`${s.name} installed`); }} />
                      ))}
                    </div>
                  ) : scope === "personal" && !q ? null : <Empty title="No skills found" text="Try another word." />}
                </section>
              );
            })()}
          </>
        )}
      </div>

      {open && (
        <PluginSheet plugin={PLUGINS.find((p) => p.id === open)!} ext={ext} status={status[open] ?? "no"} onClose={() => setOpen(null)}
          onChanged={() => void refresh()} onTry={(t) => { setOpen(null); onTry(t); }} onToast={setToast} />
      )}
      {skillOpen && (
        <SkillSheet skill={skillOpen === "new" ? null : skillOpen} ext={ext} onClose={() => setSkillOpen(null)} onToast={setToast}
          onSaved={() => { setTab("skills"); setScope("personal"); }} />
      )}
      {connections && <ConnectionsSheet status={status} onClose={() => setConnections(false)} onChanged={() => void refresh()} onOpen={(id) => { setConnections(false); setOpen(id); }} />}
      {toast && (
        <div role="status" className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-sm font-medium text-surface-000 shadow-menu">{toast}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pieces
function SectionHeader({ title, onMore, divider }: { title: string; onMore?: () => void; divider?: boolean }) {
  const inner = <>{title}{onMore && <Chevron />}</>;
  return (
    <div className={`mt-10 ${divider ? "border-b border-line pb-3" : ""}`}>
      {onMore ? (
        <button type="button" onClick={onMore} className="flex items-center gap-2 text-[22px] font-medium tracking-tight hover:opacity-80">{inner}</button>
      ) : (
        <h2 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">{inner}</h2>
      )}
    </div>
  );
}

function Scope({ scope, setScope }: { scope: "public" | "personal"; setScope: (s: "public" | "personal") => void }) {
  return (
    <div className="mt-8 flex gap-2" role="tablist" aria-label="Public or personal">
      {(["public", "personal"] as const).map((s) => (
        <button key={s} type="button" role="tab" aria-selected={scope === s} onClick={() => setScope(s)}
          className={`rounded-full px-6 py-2.5 text-[16px] font-medium transition ${scope === s ? "bg-surface-200 text-ink" : "text-ink-muted hover:text-ink"}`}>
          {s === "public" ? "Public" : "Personal"}
        </button>
      ))}
    </div>
  );
}

function PluginGrid({ list, installed, status, onOpen, onInstall }: {
  list: PluginInfo[]; installed: Set<PluginId>; status: Partial<Record<PluginId, Status>>; onOpen: (id: PluginId) => void; onInstall: (p: PluginInfo) => void;
}) {
  return (
    <div className="mt-2 grid grid-cols-1 gap-x-10 md:grid-cols-2">
      {list.map((p) => (
        <Row key={p.id} logo={<AppLogo id={p.id} size={56} framed />} title={p.name}
          text={installed.has(p.id) && status[p.id] === "no" && p.auth !== "none" ? "Installed · not connected" : p.tagline}
          onOpen={() => onOpen(p.id)} added={installed.has(p.id)} onAdd={() => onInstall(p)} />
      ))}
    </div>
  );
}

function Row({ logo, title, text, onOpen, added, onAdd }: { logo: ReactNode; title: string; text: string; onOpen: () => void; added: boolean; onAdd: () => void }) {
  return (
    <div className="flex items-center gap-4 py-4">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-4 text-left">
        {logo}
        <span className="min-w-0">
          <span className="block truncate text-[19px] font-medium">{title}</span>
          <span className="block truncate text-[16px] text-ink-muted">{text}</span>
        </span>
      </button>
      {added ? (
        <button type="button" onClick={onOpen} aria-label={`${title} installed — open settings`} title="Installed"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-surface-200 hover:text-ink">
          <svg viewBox="0 0 20 20" width="22" height="22" aria-hidden><path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      ) : (
        <button type="button" onClick={onAdd} aria-label={`Install ${title}`} title="Install"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink hover:bg-surface-200">
          <svg viewBox="0 0 20 20" width="24" height="24" aria-hidden><path d="M10 3.5v13M3.5 10h13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      )}
    </div>
  );
}

function StatusDot({ s }: { s: "on" | "off" | "needs" }) {
  if (s === "on") return null;
  return <span aria-hidden className={`absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface-000 ${s === "needs" ? "bg-warning" : "bg-ink-subtle"}`} />;
}

function SkillTile({ skill, size }: { skill: Skill; size: number }) {
  return (
    <span aria-hidden className="grid shrink-0 place-items-center border border-line bg-surface-100 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
      style={{ width: size, height: size, borderRadius: size * 0.26, fontSize: size * 0.45 }}>
      {skill.emoji ?? "✨"}
    </span>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="mt-10 rounded-3xl border border-line px-6 py-10 text-center">
      <p className="text-[17px] font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{text}</p>
    </div>
  );
}

function MenuItem({ title, hint, onClick }: { title: string; hint: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="block w-full rounded-xl px-3 py-2 text-left hover:bg-surface-300">
      <span className="block text-sm font-medium">{title}</span>
      <span className="block text-xs text-ink-subtle">{hint}</span>
    </button>
  );
}

function Sheet({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} aria-label={label} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto max-h-[90dvh] w-[min(94vw,620px)] overflow-y-auto rounded-3xl border border-line bg-composer p-0 text-ink shadow-menu backdrop:bg-black/50">
      <div className="relative p-6 md:p-7">
        <button type="button" onClick={onClose} aria-label="Close" className="absolute right-4 top-4 rounded-full px-2.5 py-1 text-ink-muted hover:bg-surface-300">✕</button>
        {children}
      </div>
    </dialog>
  );
}

function PluginSheet({ plugin: p, ext, status, onClose, onChanged, onTry, onToast }: {
  plugin: PluginInfo; ext: Ext; status: Status; onClose: () => void; onChanged: () => void; onTry: (t: string) => void; onToast: (t: string) => void;
}) {
  const row = ext.ext.plugins.find((x) => x.id === p.id);
  const isInstalled = Boolean(row);
  const configured = pluginConfigured(p);
  const signs = p.auth !== "none" && p.auth !== "server";
  const connected = !signs || status === "yes";
  const account = connected && signs ? pluginAccount(p) : null;
  const connect = (
    <PluginConnect plugin={p} label={`Connect ${p.name}`} onConnected={() => { if (!isInstalled) ext.installPlugin(p.id, true); onChanged(); onToast(`${p.name} connected`); }} />
  );
  return (
    <Sheet onClose={onClose} label={p.name}>
      <div className="flex flex-col items-center pt-2 text-center">
        <AppLogo id={p.id} size={72} framed />
        <h2 className="mt-4 text-[24px] font-semibold tracking-tight">{p.name}</h2>
        <p className="mt-1 max-w-md text-[15px] text-ink-muted">{p.description}</p>

        <div className="mt-6 flex w-full flex-col items-center gap-3">
          {!configured ? (
            <p className="text-sm text-ink-muted">{p.name} isn&apos;t set up on this server yet{p.setup ? ` (${p.setup})` : ""}.</p>
          ) : signs && !connected ? (
            <>
              {connect}
              {p.auth === "github" && status === "limited" && <p className="text-xs text-ink-subtle">Public repositories already work without connecting.</p>}
            </>
          ) : !isInstalled ? (
            <button type="button" onClick={() => { ext.installPlugin(p.id, true); onToast(`${p.name} installed`); }} className="rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-on-brand">Install</button>
          ) : (
            <p className="flex items-center gap-2 text-sm font-medium">
              <span className="h-2 w-2 rounded-full bg-success" />
              {signs ? `Connected${account ? ` as ${account}` : ""}` : "Ready to use"}
            </p>
          )}
          {connected && signs && (
            <div className="flex gap-4 text-sm text-ink-muted">
              {p.auth === "github" && githubInstallUrl() && <a href={githubInstallUrl()} target="_blank" rel="noreferrer" className="underline underline-offset-[3px] hover:text-ink">Choose repositories</a>}
              <button type="button" onClick={async () => { await disconnect(p); onChanged(); onToast(`${p.name} disconnected`); }} className="underline underline-offset-[3px] hover:text-ink">Disconnect</button>
            </div>
          )}
        </div>
      </div>

      {isInstalled && p.tools.length > 0 && (
        <label className="mt-6 flex cursor-pointer items-center justify-between gap-3 rounded-2xl bg-surface-100 px-4 py-3 text-sm">
          <span>Use in chats<span className="block text-xs text-ink-subtle">The AI uses it when it helps. Type @ to pick it for a message.</span></span>
          <input type="checkbox" checked={row?.enabled !== false} onChange={(e) => ext.enablePlugin(p.id, e.target.checked)} className="h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-surface-300 transition before:block before:h-4 before:w-4 before:translate-x-0.5 before:rounded-full before:bg-surface-000 before:shadow before:transition checked:bg-brand checked:before:translate-x-[18px]" />
        </label>
      )}
      {p.note && <p className="mt-3 text-center text-xs text-ink-subtle">{p.note}</p>}

      <Section title="Try asking">
        <div className="flex flex-wrap gap-2">
          {p.examples.map((e) => (
            <button key={e} type="button" onClick={() => onTry(e)} disabled={!isInstalled && p.tools.length > 0}
              className="rounded-full border border-line px-3.5 py-1.5 text-left text-sm hover:bg-surface-200 disabled:opacity-50" title={isInstalled ? "Start a chat with this" : "Install first"}>{e}</button>
          ))}
        </div>
      </Section>
      <p className="mt-5 text-xs leading-relaxed text-ink-subtle">{p.permissions.join(" · ")}. Your sign-in stays in this browser.</p>
      {isInstalled && (
        <button type="button" onClick={async () => { ext.installPlugin(p.id, false); await disconnect(p); onChanged(); onToast(`${p.name} uninstalled`); onClose(); }}
          className="mt-4 text-sm font-medium text-danger hover:underline">Uninstall</button>
      )}
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-5">
      <h3 className="mb-2 text-sm font-medium text-ink-subtle">{title}</h3>
      {children}
    </div>
  );
}

function SkillSheet({ skill, ext, onClose, onToast, onSaved }: { skill: Skill | null; ext: Ext; onClose: () => void; onToast: (t: string) => void; onSaved: () => void }) {
  const editable = !skill?.builtin;
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [instructions, setInstructions] = useState(skill?.instructions ?? "");
  const row = skill ? ext.ext.skills.find((s) => s.id === skill.id) : undefined;
  const field = "w-full rounded-xl border border-line-strong bg-surface-000 px-3.5 py-2 text-sm outline-none focus:border-brand";
  return (
    <Sheet onClose={onClose} label={skill?.name ?? "New skill"}>
      <div className="flex items-center gap-4 pr-8">
        {skill ? <SkillTile skill={skill} size={64} /> : <span className="grid h-16 w-16 place-items-center rounded-[17px] border border-line text-3xl">✨</span>}
        <div>
          <h2 className="text-[24px] font-semibold tracking-tight">{skill ? skill.name : "Create a skill"}</h2>
          <p className="text-[15px] text-ink-muted">{skill?.builtin ? "by Orbit" : "Personal skill"}</p>
        </div>
      </div>
      {editable ? (
        <form className="mt-5 space-y-3" onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !instructions.trim()) return;
          ext.saveSkill({ id: skill?.id, name, description, instructions });
          onToast(skill ? "Skill saved" : `Added “${name.trim()}”`);
          onSaved();
          onClose();
        }}>
          <label className="block text-sm font-medium">Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={SKILL_LIMITS.name} placeholder="e.g. My essay style" className={`mt-1 ${field}`} required />
          </label>
          <label className="block text-sm font-medium">When to use it
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={SKILL_LIMITS.description} placeholder="e.g. When I ask for help with an English essay" className={`mt-1 ${field}`} />
          </label>
          <label className="block text-sm font-medium">Instructions
            <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={SKILL_LIMITS.instructions} rows={8} required
              placeholder="e.g. Use Canadian spelling. Give feedback as bullet points. Never rewrite my paragraphs; point to what to change." className={`mt-1 resize-y ${field}`} />
            <span className="mt-1 block text-right text-xs text-ink-subtle">{instructions.length}/{SKILL_LIMITS.instructions}</span>
          </label>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={!name.trim() || !instructions.trim()} className="rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-on-brand disabled:opacity-50">{skill ? "Save" : "Create skill"}</button>
            {skill && (
              <button type="button" onClick={() => { ext.deleteSkill(skill.id); onToast("Skill deleted"); onClose(); }} className="text-sm font-medium text-danger hover:underline">Delete</button>
            )}
          </div>
        </form>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl bg-surface-100 p-4">
            {row ? (
              <>
                <label className="flex flex-1 cursor-pointer items-center justify-between gap-3 text-sm">
                  <span>Use in chats</span>
                  <input type="checkbox" checked={row.enabled} onChange={(e) => ext.installSkill(skill!.id, true, e.target.checked)} className="h-5 w-9 cursor-pointer appearance-none rounded-full bg-surface-300 transition before:block before:h-4 before:w-4 before:translate-x-0.5 before:rounded-full before:bg-surface-000 before:shadow before:transition checked:bg-brand checked:before:translate-x-[18px]" />
                </label>
              </>
            ) : (
              <button type="button" onClick={() => { ext.installSkill(skill!.id, true); onToast(`${skill!.name} installed`); }} className="rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-on-brand">Install</button>
            )}
          </div>
          <p className="mt-5 text-[15px] leading-relaxed">{skill!.description}</p>
          <Section title="Instructions the AI follows"><p className="whitespace-pre-wrap rounded-2xl border border-line p-4 text-sm leading-relaxed text-ink-muted">{skill!.instructions}</p></Section>
          {row && <button type="button" onClick={() => { ext.installSkill(skill!.id, false); onToast(`${skill!.name} uninstalled`); onClose(); }} className="mt-5 text-sm font-medium text-danger hover:underline">Uninstall</button>}
        </>
      )}
    </Sheet>
  );
}

function ConnectionsSheet({ status, onClose, onChanged, onOpen }: { status: Partial<Record<PluginId, Status>>; onClose: () => void; onChanged: () => void; onOpen: (id: PluginId) => void }) {
  const list = PLUGINS.filter((p) => p.auth !== "none" && p.auth !== "server");
  return (
    <Sheet onClose={onClose} label="Connections">
      <h2 className="text-[24px] font-semibold tracking-tight">Connections</h2>
      <p className="mt-1 text-sm text-ink-muted">Accounts this browser is signed in to. Disconnecting signs Orbit out; your plugins stay installed.</p>
      <ul className="mt-4 divide-y divide-line">
        {list.map((p) => (
          <li key={p.id} className="flex items-center gap-3 py-3">
            <AppLogo id={p.id} size={40} framed />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{p.name}</span>
              <span className="block text-xs text-ink-subtle">{!pluginConfigured(p) ? "Not set up on this server" : status[p.id] === "yes" ? "Connected" : status[p.id] === "limited" ? "Public access only" : "Not connected"}</span>
            </span>
            {status[p.id] === "yes" ? (
              <button type="button" onClick={async () => { await disconnect(p); onChanged(); }} className="rounded-full border border-line-strong px-3.5 py-1.5 text-sm hover:bg-surface-200">Disconnect</button>
            ) : pluginConfigured(p) ? (
              <button type="button" onClick={() => onOpen(p.id)} className="rounded-full border border-line-strong px-3.5 py-1.5 text-sm hover:bg-surface-200">Connect</button>
            ) : null}
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function Chevron({ down, left }: { down?: boolean; left?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={down ? 16 : 18} height={down ? 16 : 18} aria-hidden className={down ? "" : "text-ink-muted"} style={{ transform: down ? "rotate(90deg)" : left ? "rotate(180deg)" : undefined }}>
      <path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function SearchIcon() {
  return <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden className="shrink-0 text-ink-muted"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
}
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
      <path d="M10.3 3.5h3.4l.5 2.3 1.6.9 2.2-.8 1.7 2.9-1.7 1.6v1.9l1.7 1.6-1.7 2.9-2.2-.8-1.6.9-.5 2.3h-3.4l-.5-2.3-1.6-.9-2.2.8-1.7-2.9 1.7-1.6v-1.9L4.3 8.8 6 5.9l2.2.8 1.6-.9z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
