import { isProvider } from "@/config/models";
import { dbError, json, requireAppUser } from "@/lib/api";

// GET /api/conversations?provider=anthropic → this app's chats, newest first.
export async function GET(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const provider = new URL(request.url).searchParams.get("provider");
  if (!isProvider(provider) && provider !== "orbit") return json({ error: "bad_request" }, 400);

  const { data, error } = await auth.supabase
    .from("conversations")
    .select("id, title, model_id, project_id, updated_at")
    .eq("provider", provider === "orbit" ? "openai" : provider)
    .eq("orbit_mode", provider === "orbit")
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) return dbError(error, "load_failed");
  return json({
    conversations: (data ?? []).map((c) => ({
      id: c.id, title: c.title, modelId: c.model_id, projectId: c.project_id, updatedAt: c.updated_at,
    })),
  });
}
