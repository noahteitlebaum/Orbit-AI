import { createAdminClient } from "@/lib/supabase/admin";
export type EventName = "conversation_created" | "message_sent" | "response_completed" | "model_switched" | "file_uploaded" | "feature_used" | "allowance_exhausted" | "context_retrieved";
export type EventProperties = { modelId?: string; provider?: string; feature?: string; mode?: string; live?: boolean; status?: string; latencyMs?: number; count?: number };
// Server-only, explicit allowlist. Never forward arbitrary request bodies or conversation content.
export async function trackEvent(userId: string, event: EventName, properties: EventProperties = {}, conversationId?: string, dedupeKey?: string) {
  const allowed: EventProperties = {};
  for (const key of ["modelId", "provider", "feature", "mode", "status"] as const) {
    if (typeof properties[key] === "string") allowed[key] = properties[key]!.slice(0, 80);
  }
  if (typeof properties.live === "boolean") allowed.live = properties.live;
  for (const key of ["latencyMs", "count"] as const) if (Number.isFinite(properties[key])) allowed[key] = Math.max(0, Number(properties[key]));
  try {
    const { error } = await createAdminClient().from("analytics_events").insert({ user_id: userId, event, properties: allowed, conversation_id: conversationId ?? null, dedupe_key: dedupeKey ?? null });
    if (error && error.code !== "23505") console.error("analytics_write_failed", { code: error.code });
  } catch { console.error("analytics_write_failed", { code: "unavailable" }); }
}
