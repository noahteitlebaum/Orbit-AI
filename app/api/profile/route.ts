import { dbError, json, requireAppUser } from "@/lib/api";
import { cleanProfile, emptyProfile, type Memory } from "@/lib/profile/personal";

// Settings → Profile and Memory. One profile per student, used by all four AI apps.
// GET /api/profile → { profile, memories, ready }  (ready: false until migration 0008 is run)
// PUT /api/profile { …profile fields } → { profile }
const COLS = "display_name, program, level, style, length, about, instructions, memory_enabled";

export async function GET() {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const { data, error } = await auth.supabase.from("profiles").select(COLS).maybeSingle();
  if (error) return json({ profile: emptyProfile(), memories: [], ready: false });
  const { data: memories } = await auth.supabase.from("memories").select("id, content, source, created_at").order("created_at", { ascending: false }).limit(100);
  return json({ profile: data ? cleanProfile(data) : emptyProfile(), memories: (memories ?? []) as Memory[], ready: true });
}

export async function PUT(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const profile = cleanProfile(await request.json().catch(() => ({})));
  const { data, error } = await auth.supabase
    .from("profiles")
    .upsert({ user_id: auth.user.id, ...profile, updated_at: new Date().toISOString() })
    .select(COLS)
    .single();
  if (error) return dbError(error, "save_failed");
  return json({ profile: cleanProfile(data) });
}
