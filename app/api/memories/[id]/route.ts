import { isUuid, json, requireAppUser } from "@/lib/api";

// DELETE /api/memories/:id → forget one memory (RLS: only the student's own).
export async function DELETE(_: Request, ctx: RouteContext<"/api/memories/[id]">) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return json({ error: "not_found" }, 404);
  const { error } = await auth.supabase.from("memories").delete().eq("id", id);
  if (error) return json({ error: "delete_failed" }, 500);
  return json({ ok: true });
}
