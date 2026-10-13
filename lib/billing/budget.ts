import { SEMANTIC_MEMORY } from "@/config/context";
import { ECONOMICS } from "@/config/economics";
import { getModel, type ProviderId } from "@/config/models";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Usage } from "@/lib/providers/types";

// SQL v2 functions from migration 0009. No paid call may fall back to the legacy functions.
export type ReserveResult =
  | { ok: true; remaining: number }
  | { ok: false; reason: "budget" | "global_stop" | "duplicate" | "trial_expired" | "fx_not_configured" | "error"; remaining?: number };

export type CallMetadata = {
  conversationId?: string; provider?: ProviderId | "tavily" | "elevenlabs"; operation?: "chat" | "summary" | "embedding" | "search" | "image" | "transcription" | "speech";
  inputEstimate?: number; contextTarget?: number; historyDropped?: boolean; retrievedCount?: number; latencyMs?: number; unitCostUsdMicros?: number;
};
export async function reserve(userId: string, requestId: string, modelId: string, kind: "text" | "image", boundMicros: number, metadata: CallMetadata = {}): Promise<ReserveResult> {
  const { data, error } = await createAdminClient().rpc("reserve_budget_v2", {
    p_user_id: userId,
    p_request_id: requestId,
    p_model_id: modelId,
    p_kind: kind,
    p_bound_micros: Math.ceil(boundMicros),
    p_metadata: { ...metadata, provider: metadata.provider ?? getModel(modelId)?.provider ?? null, operation: metadata.operation ?? (kind === "image" ? "image" : "chat") },
    p_price_snapshot: { version: ECONOMICS.pricingVersion, input: getModel(modelId)?.inputPrice ?? (modelId===SEMANTIC_MEMORY.model?SEMANTIC_MEMORY.inputPrice:null), unitCostUsdMicros:metadata.unitCostUsdMicros??null, output: getModel(modelId)?.outputPrice ?? null,
      read: getModel(modelId)?.cachedInputPrice ?? null, write: getModel(modelId)?.cacheWritePrice ?? null },
  });
  if (error || !data) return { ok: false, reason: "error" };
  const r = data as { ok: boolean; reason?: string; remaining_micros?: number };
  if (r.ok && r.reason !== "duplicate") return { ok: true, remaining: r.remaining_micros ?? 0 };
  return { ok: false, reason: (r.reason as Exclude<ReserveResult, { ok: true }>["reason"]) ?? "error", remaining: r.remaining_micros };
}

/** settled = charge actual · uncertain = charge the full reservation · released = charge nothing. */
export async function settle(requestId: string, state: "settled" | "uncertain" | "released", actualMicros: number, usage?: Usage, errorCode?: string, metadata: CallMetadata = {}) {
  const { error } = await createAdminClient().rpc("settle_budget_v2", {
    p_request_id: requestId,
    p_state: state,
    p_actual_micros: Math.ceil(actualMicros),
    p_input_tokens: usage?.input ?? null,
    p_output_tokens: usage?.output ?? null,
    p_reasoning_tokens: usage?.reasoning ?? null,
    p_cached_tokens: usage?.cached ?? null,
    p_error_code: errorCode ?? null,
    p_cache_write_tokens: usage?.cacheWrite ?? 0,
    p_reasoning_reported: usage?.reasoningReported ?? true,
    p_metadata: metadata,
  });
  // The ledger row stays "reserved" (still counted against the budget) if this fails, so we never under-charge.
  if (error) console.error("settle_budget failed", { requestId, code: error.code });
}

/** Team switches from the settings table: is this provider turned off? */
export async function isProviderDisabled(provider: ProviderId): Promise<boolean> {
  const { data } = await createAdminClient().from("settings").select("value").eq("key", "disabled_providers").maybeSingle();
  return Array.isArray(data?.value) && (data.value as string[]).includes(provider);
}

/** Simple per-user rate limit: at most `max` model calls per minute. Spoken-reply audio isn't counted (a voice
 *  answer is read out in a few pieces, each billed separately). */
export async function overRateLimit(userId: string, max = 12): Promise<boolean> {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await createAdminClient()
    .from("ledger")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .neq("model_id", "voice-speak")
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
    .eq("operation", "chat")
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

export async function getUsage(userId: string): Promise<{ allowance: number; spent: number; reserved: number; currency?: string; allowanceCad?: number | null; usdCadRate?: number | null; expiresAt?: string | null } | null> {
  const { data } = await createAdminClient()
    .from("budgets")
    .select("allowance_micros, spent_micros, reserved_micros, allowance_cad_micros, usd_cad_rate, expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) {
    const {data: settings} = await createAdminClient().from("settings").select("key,value").in("key",["trial_allowance_cad_micros","usd_cad_rate"]);
    const values = new Map((settings??[]).map(s=>[s.key,s.value]));
    const rate=Number(values.get("usd_cad_rate")??0),cad=Number(values.get("trial_allowance_cad_micros")??ECONOMICS.trialAllowanceCadMicros);
    return {allowance:rate>0?Math.floor(cad/rate):0,spent:0,reserved:0,currency:"USD",allowanceCad:cad,usdCadRate:rate>0?rate:null};
  }
  return { allowance: Number(data.allowance_micros), spent: Number(data.spent_micros), reserved: Number(data.reserved_micros),currency:"USD",allowanceCad:data.allowance_cad_micros,usdCadRate:data.usd_cad_rate?Number(data.usd_cad_rate):null,expiresAt:data.expires_at };
}
