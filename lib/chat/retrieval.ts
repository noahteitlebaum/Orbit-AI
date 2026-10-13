import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONTEXT, SEMANTIC_MEMORY as S } from "@/config/context";
import { reserve, settle } from "@/lib/billing/budget";
import { estimateTokens } from "./context";
import type { Memory } from "@/lib/profile/personal";
import { isProviderDisabled } from "@/lib/billing/budget";

export type RetrievalSource = { id: string; kind: "message" | "summary" | "memory"; content: string };
export type RetrievalHit = { source_id: string; source_kind: RetrievalSource["kind"]; content: string; similarity: number };
export function selectRetrieval(hits: RetrievalHit[], excluded: Set<string>, tokenLimit = CONTEXT.retrievalTokens) {
  const seen = new Set(excluded);
  const selected: RetrievalHit[] = [];
  let tokens = 0;
  for (const h of [...hits].sort((a,b) => b.similarity-a.similarity)) {
    if (seen.has(h.source_id) || h.similarity < S.minSimilarity) continue;
    const size = estimateTokens(`[Earlier ${h.source_kind} ${selected.length+1}]\n${h.content}\n\n`);
    if (tokens + size > tokenLimit) continue;
    seen.add(h.source_id); tokens += size; selected.push(h);
    if (selected.length >= S.limit) break;
  }
  return { block: selected.map((h,i) => `[Earlier ${h.source_kind} ${i+1}]\n${h.content}`).join("\n\n"), count: selected.length };
}

// Only after the student's memory opt-in. Every embedding call is reserved and reconciled, including query vectors.
async function embed(userId: string, conversationId: string, texts: string[]): Promise<number[][] | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !texts.length || await isProviderDisabled("openai")) return null;
  const requestId = randomUUID();
  const bound = Math.ceil(texts.reduce((n,t) => n+estimateTokens(t),0)*1.15*S.inputPrice);
  const r = await reserve(userId, requestId, S.model, "text", Math.max(1,bound), { provider: "openai", operation: "embedding", conversationId });
  if (!r.ok) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: S.model, input: texts, dimensions: S.dimensions }), signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      // Unknown/server failures can have incurred work; only explicit auth/validation rejection releases.
      await settle(requestId, [400,401,403,404,429].includes(res.status) ? "released" : "uncertain", 0, undefined, "embedding_failed"); return null;
    }
    const data = await res.json();
    const usage = data.usage;
    if (typeof usage?.prompt_tokens === "number") await settle(requestId,"settled",Math.ceil(usage.prompt_tokens*S.inputPrice),{input:usage.prompt_tokens,output:0,reasoning:0,cached:0});
    else await settle(requestId,"uncertain",0,undefined,"no_usage");
    const vectors = (data.data ?? []).sort((a: {index:number},b: {index:number}) => a.index-b.index).map((d: {embedding:number[]}) => d.embedding);
    if (vectors.length !== texts.length || vectors.some((v: number[]) => v.length !== S.dimensions || v.some(x=>!Number.isFinite(x)))) return null;
    return vectors;
  } catch { await settle(requestId,"uncertain",0,undefined,"embedding_failed"); return null; }
}

export async function retrieveRelevant(o: { supabase: SupabaseClient; userId: string; conversationId: string; enabled: boolean; query: string;
  sources: RetrievalSource[]; memories: Memory[]; excluded: Set<string> }) {
  const empty = { block: "", count: 0 };
  if (!o.enabled || process.env.SMART_MEMORY_ENABLED !== "on") return empty;
  try {
    // Bounded lazy backfill. Query RLS checks the preference again if it changed since loadPersonal().
    const { data: profile } = await o.supabase.from("profiles").select("memory_enabled").eq("user_id",o.userId).maybeSingle();
    if (!profile?.memory_enabled) return empty;
    const possible = [...o.memories.map(m=>({id:m.id,kind:"memory" as const,content:m.content})),...o.sources];
    const { data: indexed, error } = await o.supabase.from("context_embeddings").select("source_id, content_hash").eq("user_id",o.userId).in("source_id",possible.map(s=>s.id));
    if (error) return empty; // feature is optional; missing migration must not break chat
    const hashes = new Map((indexed ?? []).map(e=>[e.source_id,e.content_hash]));
    const candidates = possible
      .map(s=>({...s,content:s.content.slice(0,S.sourceChars)})).filter(s=>s.content.trim())
      .map(s=>({...s,hash:createHash("sha256").update(s.content).digest("hex")}))
      .filter(s=>hashes.get(s.id)!==s.hash).slice(0,S.indexBatch);
    const vectors = await embed(o.userId,o.conversationId,[o.query.slice(0,S.sourceChars),...candidates.map(s=>s.content)]);
    if (!vectors) return empty;
    if (candidates.length) {
      const { error: writeError } = await o.supabase.from("context_embeddings").upsert(candidates.map((s,i)=>({user_id:o.userId,source_id:s.id,source_kind:s.kind,
        conversation_id:s.kind==='memory'?null:o.conversationId,message_id:s.kind==='message'?s.id:null,memory_id:s.kind==='memory'?s.id:null,
        content_hash:s.hash,embedding:JSON.stringify(vectors[i+1]),model:S.model})),{onConflict:"user_id,source_kind,source_id"});
      if (writeError) return empty;
    }
    const { data: hits, error: readError } = await o.supabase.rpc("retrieve_context",{p_embedding:JSON.stringify(vectors[0]),p_conversation_id:o.conversationId,p_limit:8});
    if (readError) return empty;
    return selectRetrieval((hits ?? []) as RetrievalHit[],o.excluded);
  } catch { return empty; } // summary/recent-history fallback, no prompt text in logs
}
