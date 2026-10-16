import type { ModelOption } from "@/config/models";
import { ORBIT } from "@/config/orbit";
import { isProviderDisabled, reserve, settle } from "@/lib/billing/budget";
import { costMicros, estimateTokens, reservationMicros } from "@/lib/chat/context";
import { ADAPTERS, apiKeyFor } from "@/lib/providers";
import { ProviderError, type ChatTurn, type FinishReason, type Usage } from "@/lib/providers/types";

export class OrbitError extends Error {
  constructor(public code: string) { super(code); }
}

export function orbitInputTokens(system: string, history: ChatTurn[]): number {
  return estimateTokens(system) + history.reduce((n,t) => n + estimateTokens(t.content) + 8,0);
}

/** Every paid phase has its own priced ledger row. Never logs prompt or output text. */
export async function orbitCall(o: {
  userId: string; conversationId: string; model: ModelOption; operation: "orbit_vote" | "orbit_specialist" | "orbit_answer";
  system: string; history: ChatTurn[]; maxOutput: number; signal: AbortSignal; delta?: (text: string) => void;
}): Promise<{ text: string; finish: FinishReason }> {
  const key = apiKeyFor(o.model.provider);
  if (!key || await isProviderDisabled(o.model.provider)) throw new OrbitError("orbit_provider_unavailable");
  if (o.signal.aborted) throw new OrbitError("orbit_cancelled");
  const input = orbitInputTokens(o.system,o.history);
  if (input > ORBIT.inputTokens) throw new OrbitError("context_too_large");
  const id = crypto.randomUUID();
  const r = await reserve(o.userId,id,o.model.id,"text",reservationMicros(o.model,input,o.maxOutput),{
    conversationId:o.conversationId,provider:o.model.provider,operation:o.operation,inputEstimate:input,
  });
  if (!r.ok) throw new OrbitError(r.reason === "global_stop" ? "paused" : r.reason === "error" ? "reserve_failed" : r.reason);
  let text = "", usage: Usage | undefined, finish: FinishReason = "unknown";
  try {
    for await (const event of ADAPTERS[o.model.provider].stream({ model:o.model,system:o.system,history:o.history,maxOutput:o.maxOutput,apiKey:key,signal:o.signal })) {
      if (event.delta) { text += event.delta; o.delta?.(event.delta); }
      if (event.usage) usage = event.usage;
      if (event.finish) finish = event.finish;
    }
  } catch (error) {
    if (usage) await settle(id,"settled",costMicros(o.model,usage),usage,"orbit_call_failed");
    else if (error instanceof ProviderError && !error.started && error.status != null && error.status >= 400 && error.status < 500 && error.status !== 408)
      await settle(id,"released",0,undefined,error.code);
    else await settle(id,"uncertain",0,undefined,"orbit_call_failed");
    throw new OrbitError("orbit_call_failed");
  }
  if (usage) await settle(id,"settled",costMicros(o.model,usage),usage,undefined,{finishReason:finish});
  else await settle(id,"uncertain",0,undefined,"no_usage");
  if (finish !== "stop" || !text.trim()) throw new OrbitError("orbit_incomplete_response");
  return { text,finish };
}
