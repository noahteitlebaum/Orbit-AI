import { defaultModelFor, isProvider } from "@/config/models";
import { dbError, json, requireAppUser } from "@/lib/api";
import { trackEvent } from "@/lib/analytics/events";
import { cleanChats } from "@/lib/import/history";

// POST /api/import { provider, source: "chatgpt" | "claude", chats: ImportedChat[] } → { imported, duplicates }
// Saves chats from a ChatGPT/Claude export into one Orbit app (Settings → Import). The browser parses the export and
// sends it in batches; nothing calls a model, so it's free. Re-importing the same export skips chats already saved.
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const { user, supabase } = auth;
  const body = (await request.json().catch(() => null)) as { provider?: unknown; source?: unknown; chats?: unknown } | null;
  if (!body || !isProvider(body.provider) || (body.source !== "chatgpt" && body.source !== "claude")) return json({ error: "bad_request" }, 400);
  const chats = cleanChats(body.chats);
  if (!chats) return json({ error: "bad_request" }, 400);
  if (!chats.length) return json({ imported: 0, duplicates: 0 });

  // Chats (duplicates of an earlier import are skipped by the unique import_key).
  const rows = chats.map((c) => ({
    user_id: user.id, provider: body.provider, model_id: defaultModelFor(body.provider as never), title: c.title,
    imported_from: body.source, import_key: c.key,
    ...(c.createdAt ? { created_at: c.createdAt } : {}), updated_at: c.updatedAt ?? c.createdAt ?? new Date().toISOString(),
  }));
  const { data: saved, error } = await supabase.from("conversations")
    .upsert(rows, { onConflict: "user_id,import_key", ignoreDuplicates: true })
    .select("id, import_key");
  if (error) return /import_key|imported_from|column|constraint/i.test(error.message ?? "") ? json({ error: "db_setup" }, 503) : dbError(error, "save_failed");
  const idFor = new Map((saved ?? []).map((r) => [r.import_key as string, r.id as string]));

  // Messages, in order (seq follows insertion order), keeping their original times.
  const messages = chats.flatMap((c) => {
    const conversationId = idFor.get(c.key);
    if (!conversationId) return [];
    return c.messages.map((m) => ({ conversation_id: conversationId, user_id: user.id, role: m.role, content: m.content, status: "complete", ...(m.at ? { created_at: m.at } : {}) }));
  });
  for (let i = 0; i < messages.length; i += 500) {
    const { error: e } = await supabase.from("messages").insert(messages.slice(i, i + 500));
    if (e) {
      // Don't leave half-imported chats behind: remove this batch's new chats so a retry imports them cleanly.
      await supabase.from("conversations").delete().in("id", [...idFor.values()]);
      return dbError(e, "save_failed");
    }
  }
  await trackEvent(user.id, "feature_used", { feature: `import_${body.source}`, provider: body.provider, count: idFor.size });
  return json({ imported: idFor.size, duplicates: chats.length - idFor.size });
}
