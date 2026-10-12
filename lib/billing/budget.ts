import type { ProviderId } from "@/config/models";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Usage } from "@/lib/providers/types";

// Thin wrappers over the SQL functions in supabase/migrations/0001_core.sql.
export type ReserveResult =
  | { ok: true; remaining: number }
  | { ok: false; reason: "budget" | "global_stop" | "duplicate" | "error"; remaining?: number };

export async function reserve(userId: string, requestId: string, modelId: string, kind: "text" | "image", boundMicros: number): Promise<ReserveResult> {
  const { data, error } = await createAdminClient().rpc("reserve_budget", {
    p_user_id: userId,
    p_request_id: requestId,
    p_model_id: modelId,
    p_kind: kind,
    p_bound_micros: Math.ceil(boundMicros),
  });
  if (error || !data) return { ok: false, reason: "error" };
  const r = data as { ok: boolean; reason?: string; remaining_micros?: number };
  if (r.ok && r.reason !== "duplicate") return { ok: true, remaining: r.remaining_micros ?? 0 };
  return { ok: false, reason: (r.reason as "budget" | "global_stop" | "duplicate") ?? "error", remaining: r.remaining_micros };
}

/** settled = charge actual · uncertain = charge the full reservation · released = charge nothing. */
export async function settle(requestId: string, state: "settled" | "uncertain" | "released", actualMicros: number, usage?: Usage, errorCode?: string) {
  const { error } = await createAdminClient().rpc("settle_budget", {
    p_request_id: requestId,
    p_state: state,
    p_actual_micros: Math.ceil(actualMicros),
    p_input_tokens: usage?.input ?? null,
    p_output_tokens: usage?.output ?? null,
    p_reasoning_tokens: usage?.reasoning ?? null,
    p_cached_tokens: usage?.cached ?? null,
    p_error_code: errorCode ?? null,
  });
  // The ledger row stays "reserved" (still counted against the budget) if this fails, so we never under-charge.
  if (error) console.error("settle_budget failed", { requestId, code: error.code });
}

/** Team switches from the settings table: is this provider turned off? */
export async function isProviderDisabled(provider: ProviderId): Promise<boolean> {
  const { data } = await createAdminClient().from("settings").select("value").eq("key", "disabled_providers").maybeSingle();
  return Array.isArray(data?.value) && (data.value as string[]).includes(provider);
}

/** Simple per-user rate limit: at most `max` model calls per minute. */
export async function overRateLimit(userId: string, max = 12): Promise<boolean> {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await createAdminClient()
    .from("ledger")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since);
  return (count ?? 0) >= max;
}

/** The student's average actual cost per answer, by model, from their last 100 settled answers (for estimates). */
export async function recentAnswerCosts(userId: string): Promise<Record<string, number>> {
  const { data } = await createAdminClient()
    .from("ledger")
    .select("model_id, actual_micros")
    .eq("user_id", userId)
    .eq("kind", "text")
    .eq("state", "settled")
    .order("created_at", { ascending: false })
    .limit(100);
  const sums = new Map<string, { total: number; n: number }>();
  for (const r of data ?? []) {
    const s = sums.get(r.model_id) ?? { total: 0, n: 0 };
    s.total += Number(r.actual_micros ?? 0);
    s.n++;
    sums.set(r.model_id, s);
  }
  // Need a few answers before trusting the average.
  return Object.fromEntries([...sums].filter(([, s]) => s.n >= 3).map(([id, s]) => [id, Math.ceil(s.total / s.n)]));
}

export async function getUsage(userId: string): Promise<{ allowance: number; spent: number; reserved: number } | null> {
  const { data } = await createAdminClient()
    .from("budgets")
    .select("allowance_micros, spent_micros, reserved_micros")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) {
    const { data: s } = await createAdminClient().from("settings").select("value").eq("key", "default_allowance_micros").maybeSingle();
    return { allowance: Number(s?.value ?? 0), spent: 0, reserved: 0 };
  }
  return { allowance: Number(data.allowance_micros), spent: Number(data.spent_micros), reserved: Number(data.reserved_micros) };
}
