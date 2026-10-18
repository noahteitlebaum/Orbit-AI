import { isProvider } from "@/config/models";
import { dbError, json, requireAppUser } from "@/lib/api";

// Courses (stored as "projects"). Each app has its own courses; they never cross over.
// GET  /api/projects?provider=… → this app's courses
// POST /api/projects { provider, name, instructions? }
export async function GET(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const provider = new URL(request.url).searchParams.get("provider");
  if (!isProvider(provider)) return json({ error: "bad_request" }, 400);
  const { data, error } = await auth.supabase
    .from("projects")
    .select("id, name, instructions, updated_at")
    .eq("user_id", auth.user.id)
    .order("updated_at", { ascending: false });
  if (error) return dbError(error, "load_failed");
  return json({ projects: data ?? [] });
}

export async function POST(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const body = (await request.json().catch(() => ({}))) as { provider?: unknown; name?: unknown; instructions?: unknown };
  if (!isProvider(body.provider)) return json({ error: "bad_request" }, 400);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  const instructions = typeof body.instructions === "string" ? body.instructions.slice(0, 8000) : "";
  if (!name) return json({ error: "bad_request" }, 400);
  const { data, error } = await auth.supabase
    .from("projects")
    .insert({ user_id: auth.user.id, provider: null, name, instructions })
    .select("id, name, instructions, updated_at")
    .single();
  if (error) return dbError(error, "save_failed");
  return json({ project: data });
}
