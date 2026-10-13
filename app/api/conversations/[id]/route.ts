import { getModel } from "@/config/models";
import { dbError, isUuid, json, requireAppUser } from "@/lib/api";

// GET    /api/conversations/:id → messages (generated images come back as short-lived signed URLs)
// PATCH  /api/conversations/:id { title?, projectId?, modelId? }
// DELETE /api/conversations/:id
export async function GET(_: Request, ctx: RouteContext<"/api/conversations/[id]">) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "not_found" }, 404);

  const { data: conv } = await auth.supabase.from("conversations").select("id, mode, course_only, summary, summary_upto").eq("id", id).maybeSingle();
  if (!conv) return json({ error: "not_found" }, 404);
  const { data: q } = await auth.supabase.from("conversations").select("quiz_state").eq("id", id).maybeSingle(); // migration 0006
  const cols = "id, role, kind, content, image_path, model_id, status, attachment_ids, sources";
  const load = (extra: string) => auth.supabase.from("messages").select(cols + extra).eq("conversation_id", id).order("seq");
  // tool_log arrives with migration 0004; chats still load if it hasn't been run yet.
  let { data: rows, error } = (await load(", tool_log")) as unknown as { data: Record<string, unknown>[] | null; error: { code?: string } | null };
  if (error) ({ data: rows, error } = (await load("")) as unknown as { data: Record<string, unknown>[] | null; error: { code?: string } | null });
  if (error) return dbError(error, "load_failed");

  const paths = (rows ?? []).filter((m) => m.image_path).map((m) => m.image_path as string);
  const urls = new Map<string, string>();
  if (paths.length) {
    const { data: signed } = await auth.supabase.storage.from("generated").createSignedUrls(paths, 60 * 60);
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }

  // Attachment chips (name, type, status) for each student message.
  const fileIds = [...new Set((rows ?? []).flatMap((m) => (m.attachment_ids as string[] | null) ?? []))];
  const files = new Map<string, { id: string; name: string; kind: string; status: string; error: string | null; project_id: string | null }>();
  if (fileIds.length) {
    const { data: f } = await auth.supabase.from("files").select("id, name, kind, status, error, project_id").in("id", fileIds);
    for (const x of f ?? []) files.set(x.id, x);
  }

  return json({
    mode: conv.mode,
    courseOnly: conv.course_only,
    summarized: Boolean(conv.summary),
    // Never imply that an old partial summary covers everything after reopening.
    summaryIncomplete: Boolean(conv.summary && conv.summary_upto==null),
    quiz: q?.quiz_state ?? null,
    messages: (rows ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      kind: m.kind,
      content: m.content,
      imageUrl: m.image_path ? urls.get(m.image_path as string) ?? null : undefined,
      modelId: m.model_id ?? undefined,
      status: m.status,
      attachments: ((m.attachment_ids as string[] | null) ?? []).map((fid) => files.get(fid)).filter(Boolean),
      sources: m.sources ?? undefined,
      toolLog: m.tool_log ?? undefined,
    })),
  });
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/conversations/[id]">) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "not_found" }, 404);
  const body = (await request.json().catch(() => ({}))) as { title?: unknown; projectId?: unknown; modelId?: unknown };

  const patch: Record<string, unknown> = {};
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim().slice(0, 120);
  if (body.projectId === null || isUuid(body.projectId)) patch.project_id = body.projectId;
  if (typeof body.modelId === "string") {
    const { data: conv } = await auth.supabase.from("conversations").select("provider").eq("id", id).maybeSingle();
    const model = getModel(body.modelId);
    if (!conv || !model || !model.enabled) return json({ error: "unknown_model" }, 400);
    patch.model_id = model.id;
  }
  if (!Object.keys(patch).length) return json({ error: "bad_request" }, 400);

  // RLS also checks that a project belongs to this user and the same app.
  const { error } = await auth.supabase.from("conversations").update(patch).eq("id", id);
  if (error) return dbError(error, "save_failed", 400);
  return json({ ok: true });
}

export async function DELETE(_: Request, ctx: RouteContext<"/api/conversations/[id]">) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "not_found" }, 404);
  // Remove this chat's uploaded files from storage too (rows go with the chat).
  const { data: files } = await auth.supabase.from("files").select("storage_path").eq("conversation_id", id);
  if (files?.length) await auth.supabase.storage.from("uploads").remove(files.map((f) => f.storage_path as string));
  const { error } = await auth.supabase.from("conversations").delete().eq("id", id);
  if (error) return json({ error: "delete_failed" }, 500);
  return json({ ok: true });
}
