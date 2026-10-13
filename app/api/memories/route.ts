import { dbError, json, requireAppUser } from "@/lib/api";
import { LIMITS } from "@/lib/profile/personal";

// Saved memories (Settings → Memory). The student can add, see and delete every one.
// POST   /api/memories { content } → { memory }
// DELETE /api/memories → deletes all of them
export async function POST(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const body = (await request.json().catch(() => ({}))) as { content?: unknown };
  const content = typeof body.content === "string" ? body.content.trim().slice(0, LIMITS.memory) : "";
  if (!content) return json({ error: "bad_request" }, 400);
  const { count } = await auth.supabase.from("memories").select("id", { count: "exact", head: true });
  if ((count ?? 0) >= LIMITS.memories) return json({ error: "too_many" }, 400);
  const { data, error } = await auth.supabase
    .from("memories")
    .insert({ user_id: auth.user.id, content, source: "student" })
    .select("id, content, source, created_at")
    .single();
  if (error) return dbError(error, "save_failed");
  return json({ memory: data });
}

export async function DELETE() {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const { error } = await auth.supabase.from("memories").delete().eq("user_id", auth.user.id);
  if (error) return json({ error: "delete_failed" }, 500);
  return json({ ok: true });
}
