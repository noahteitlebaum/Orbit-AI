"use client";
// Browser: the student's installed plugins and skills. Saved to their account (/api/extensions, migration 0013) so it
// follows them to any device; also kept in this browser so the page works before the migration is run.
import { useCallback, useEffect, useRef, useState } from "react";
import { isPluginId, type PluginId } from "./catalog";
import { loadServerReady } from "./connect";
import { githubConnectReady } from "@/lib/connectors/github-connect";
import { BUILTIN_SKILLS, SKILL_LIMITS, type Skill } from "./skills";

export type InstalledPlugin = { id: PluginId; enabled: boolean };
export type InstalledSkill = { id: string; enabled: boolean };
export type Extensions = { plugins: InstalledPlugin[]; skills: InstalledSkill[]; personal: Skill[] };

const KEY = "orbit.extensions";
const EMPTY: Extensions = { plugins: [], skills: [], personal: [] };

function loadLocal(): Extensions {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Extensions | null;
    if (!v) return EMPTY;
    return { plugins: (v.plugins ?? []).filter((p) => isPluginId(p.id)), skills: v.skills ?? [], personal: v.personal ?? [] };
  } catch {
    return EMPTY;
  }
}
function saveLocal(x: Extensions) {
  try {
    localStorage.setItem(KEY, JSON.stringify(x));
  } catch {}
}

async function put(body: object) {
  await fetch("/api/extensions", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
}

/** Every skill the student can see: built-in ones and their own. */
export function allSkills(x: Extensions): Skill[] {
  return [...BUILTIN_SKILLS, ...x.personal];
}

/** Installed + enabled skills, ready to send with a chat request. */
export function activeSkills(x: Extensions): { name: string; description: string; instructions: string }[] {
  const on = new Set(x.skills.filter((s) => s.enabled).map((s) => s.id));
  return allSkills(x).filter((s) => on.has(s.id)).map(({ name, description, instructions }) => ({ name, description, instructions }));
}

export function useExtensions() {
  const [ext, setExt] = useState<Extensions>(EMPTY);
  const [synced, setSynced] = useState(false); // false = account storage not available yet (migration 0013)
  const current = useRef<Extensions>(EMPTY);
  useEffect(() => {
    current.current = ext;
  }, [ext]);

  useEffect(() => {
    const local = loadLocal();
    void loadServerReady(); // which server-key plugins (Wolfram|Alpha) are set up
    void githubConnectReady(); // so Connect GitHub can open its pop-up straight from a click
    setExt(local); // eslint-disable-line react-hooks/set-state-in-effect -- browser storage is only readable after mount
    fetch("/api/extensions")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { ready?: boolean; plugins?: InstalledPlugin[]; skills?: (InstalledSkill & Partial<Skill>)[] } | null) => {
        if (!j?.ready) return;
        setSynced(true);
        const fromServer: Extensions = {
          plugins: (j.plugins ?? []).filter((p) => isPluginId(p.id)),
          skills: (j.skills ?? []).map((s) => ({ id: s.id, enabled: s.enabled })),
          personal: (j.skills ?? []).filter((s) => s.id.startsWith("p-") && s.name && s.instructions)
            .map((s) => ({ id: s.id, name: s.name!, description: s.description ?? "", instructions: s.instructions! })),
        };
        // First time on the account: carry over what was installed in this browser.
        const empty = !fromServer.plugins.length && !fromServer.skills.length;
        if (empty && (local.plugins.length || local.skills.length)) {
          local.plugins.forEach((p) => void put({ kind: "plugin", id: p.id, installed: true, enabled: p.enabled }));
          local.skills.forEach((s) => void put({ kind: "skill", id: s.id, installed: true, enabled: s.enabled, skill: local.personal.find((x) => x.id === s.id) }));
          return;
        }
        setExt(fromServer);
        saveLocal(fromServer);
      })
      .catch(() => {});
  }, []);

  const update = useCallback((fn: (x: Extensions) => Extensions) => {
    setExt((prev) => {
      const next = fn(prev);
      saveLocal(next);
      return next;
    });
  }, []);

  const installPlugin = useCallback((id: PluginId, installed: boolean) => {
    update((x) => ({ ...x, plugins: installed ? [...x.plugins.filter((p) => p.id !== id), { id, enabled: true }] : x.plugins.filter((p) => p.id !== id) }));
    void put({ kind: "plugin", id, installed, enabled: true });
  }, [update]);

  const enablePlugin = useCallback((id: PluginId, enabled: boolean) => {
    update((x) => ({ ...x, plugins: x.plugins.map((p) => (p.id === id ? { ...p, enabled } : p)) }));
    void put({ kind: "plugin", id, installed: true, enabled });
  }, [update]);

  const installSkill = useCallback((id: string, installed: boolean, enabled = true) => {
    const personal = current.current.personal.find((s) => s.id === id);
    update((x) => ({ ...x, skills: installed ? [...x.skills.filter((s) => s.id !== id), { id, enabled }] : x.skills.filter((s) => s.id !== id) }));
    void put({ kind: "skill", id, installed, enabled, skill: personal });
  }, [update]);

  /** Create or edit one of the student's own skills (installed and on). */
  const saveSkill = useCallback((s: Omit<Skill, "id"> & { id?: string }) => {
    const skill: Skill = {
      id: s.id ?? `p-${crypto.randomUUID()}`,
      name: s.name.trim().slice(0, SKILL_LIMITS.name), description: s.description.trim().slice(0, SKILL_LIMITS.description),
      instructions: s.instructions.trim().slice(0, SKILL_LIMITS.instructions),
    };
    update((x) => ({
      personal: [...x.personal.filter((p) => p.id !== skill.id), skill],
      skills: [...x.skills.filter((p) => p.id !== skill.id), { id: skill.id, enabled: true }],
      plugins: x.plugins,
    }));
    void put({ kind: "skill", id: skill.id, installed: true, enabled: true, skill });
    return skill;
  }, [update]);

  const deleteSkill = useCallback((id: string) => {
    update((x) => ({ ...x, personal: x.personal.filter((p) => p.id !== id), skills: x.skills.filter((p) => p.id !== id) }));
    void put({ kind: "skill", id, installed: false });
  }, [update]);

  return { ext, synced, installPlugin, enablePlugin, installSkill, saveSkill, deleteSkill };
}
