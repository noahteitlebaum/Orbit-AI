import { dbError, json, requireAppUser } from "@/lib/api";
import { isPluginId } from "@/lib/plugins/catalog";
import { BUILTIN_SKILLS, SKILL_LIMITS } from "@/lib/plugins/skills";

// Installed plugins and skills (Plugins page; migration 0013). Tokens are never sent here.
// GET  /api/extensions → { plugins: [{ id, enabled }], skills: [{ id, enabled, name?, description?, instructions? }], ready }
// PUT  /api/extensions { kind: "plugin"|"skill", id, installed: boolean, enabled?, skill?: { name, description, instructions } }
const MAX_PERSONAL_SKILLS = 30;
const builtin = new Set(BUILTIN_SKILLS.map((s) => s.id));
const personalId = (v: unknown): v is string => typeof v === "string" && /^p-[0-9a-f-]{36}$/.test(v);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "");

export async function GET() {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const { data, error } = await auth.supabase.from("user_extensions").select("kind, ext_id, enabled, data").order("created_at");
  if (error) return json({ plugins: [], skills: [], ready: false }); // migration 0013 not run yet: the browser keeps them locally
  const rows = (data ?? []) as { kind: string; ext_id: string; enabled: boolean; data: Record<string, unknown> }[];
  return json({
    ready: true,
    plugins: rows.filter((r) => r.kind === "plugin" && isPluginId(r.ext_id)).map((r) => ({ id: r.ext_id, enabled: r.enabled })),
    skills: rows.filter((r) => r.kind === "skill").map((r) => ({
      id: r.ext_id, enabled: r.enabled,
      ...(personalId(r.ext_id) ? { name: str(r.data.name, SKILL_LIMITS.name), description: str(r.data.description, SKILL_LIMITS.description), instructions: str(r.data.instructions, SKILL_LIMITS.instructions) } : {}),
    })),
  });
}

export async function PUT(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const body = (await request.json().catch(() => ({}))) as { kind?: unknown; id?: unknown; installed?: unknown; enabled?: unknown; skill?: unknown };
  const kind = body.kind === "plugin" || body.kind === "skill" ? body.kind : null;
  const id = typeof body.id === "string" ? body.id : "";
  const valid = kind === "plugin" ? isPluginId(id) : kind === "skill" ? builtin.has(id) || personalId(id) : false;
  if (!kind || !valid || typeof body.installed !== "boolean") return json({ error: "bad_request" }, 400);
  const table = auth.supabase.from("user_extensions");
  if (!body.installed) {
    const { error } = await table.delete().eq("kind", kind).eq("ext_id", id);
    return error ? dbError(error, "save_failed") : json({ ok: true });
  }
  let data: Record<string, string> = {};
  if (kind === "skill" && personalId(id)) {
    const sk = (body.skill ?? {}) as Record<string, unknown>;
    data = { name: str(sk.name, SKILL_LIMITS.name), description: str(sk.description, SKILL_LIMITS.description), instructions: str(sk.instructions, SKILL_LIMITS.instructions) };
    if (!data.name || !data.instructions) return json({ error: "bad_request" }, 400);
    const { count } = await auth.supabase.from("user_extensions").select("ext_id", { count: "exact", head: true }).eq("kind", "skill").like("ext_id", "p-%");
    if ((count ?? 0) >= MAX_PERSONAL_SKILLS) {
      const { data: existing } = await auth.supabase.from("user_extensions").select("ext_id").eq("kind", "skill").eq("ext_id", id).maybeSingle();
      if (!existing) return json({ error: "too_many_skills" }, 400);
    }
  }
  const { error } = await table.upsert({
    user_id: auth.user.id, kind, ext_id: id, enabled: body.enabled !== false, data, updated_at: new Date().toISOString(),
  });
  return error ? dbError(error, "save_failed") : json({ ok: true });
}
