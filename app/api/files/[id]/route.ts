import { dbError, isUuid, json, requireAppUser } from "@/lib/api";

// PATCH  /api/files/:id { projectId } → save a chat attachment to a course (or take it out with null), so every chat
//                                       in the course can use it without uploading it again. It stays in its chat too.
// DELETE /api/files/:id → removes the stored file, its passages, and its row.
export async function PATCH(request: Request, ctx: RouteContext<"/api/files/[id]">) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { projectId?: unknown };
  if (!isUuid(id) || !(body.projectId === null || isUuid(body.projectId))) return json({ error: "bad_request" }, 400);
  // RLS also checks the course belongs to this student.
  const { data, error } = await auth.supabase.from("files").update({ project_id: body.projectId }).eq("id", id).select("id, project_id").maybeSingle();
  if (error) return dbError(error, "save_failed", 400);
  if (!data) return json({ error: "not_found" }, 404);
  return json({ ok: true, projectId: data.project_id });
}

export async function DELETE(_: Request, ctx: RouteContext<"/api/files/[id]">) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "not_found" }, 404);
  const { data: file } = await auth.supabase.from("files").select("storage_path").eq("id", id).maybeSingle();
  if (!file) return json({ error: "not_found" }, 404);
  await auth.supabase.storage.from("uploads").remove([file.storage_path]);
  const { error } = await auth.supabase.from("files").delete().eq("id", id);
  if (error) return json({ error: "delete_failed" }, 500);
  return json({ ok: true });
}
