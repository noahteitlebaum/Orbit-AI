import type { ImageModel, ModelOption, ProviderId } from "@/config/models";
import type { ToolDef } from "@/lib/folder/tools";

// Provider-neutral shapes (see docs/ARCHITECTURE.md). Server-only.
export type TurnImage = { mime: string; data: string }; // base64
/** A PDF the model reads page by page (text and visuals). Only for providers with PDF_INPUT in config/models.ts. */
export type TurnDocument = { name: string; mime: "application/pdf"; data: string }; // base64
/** A function call the model made. `meta` carries provider data that must be sent back (Gemini thought signatures). */
export type ToolCall = { id: string; name: string; args: Record<string, unknown>; meta?: { thoughtSignature?: string; providerId?: boolean } };
export type ToolResult = { id: string; name: string; output: string };
// Assistant turns may carry toolCalls; the user turn after them carries the matching toolResults.
export type ChatTurn = { role: "user" | "assistant"; content: string; images?: TurnImage[]; documents?: TurnDocument[]; toolCalls?: ToolCall[]; toolResults?: ToolResult[] };

export interface Usage {
  input: number;     // prompt tokens
  output: number;    // billable output tokens, including reasoning/thinking
  reasoning: number; // part of output spent on reasoning (for reporting)
  cached: number;    // prompt tokens served from cache (reporting only; billed at full price to stay safe)
}

export type StreamEvent = { delta?: string; usage?: Usage; toolCall?: ToolCall };

export type ProviderErrorCode = "timeout" | "rate_limit" | "auth" | "unavailable" | "bad_request" | "model_unavailable" | "not_configured" | "unknown";

export class ProviderError extends Error {
  constructor(public code: ProviderErrorCode, public status?: number, public started = false) {
    super(code);
  }
}

export interface StreamArgs {
  model: ModelOption;
  system: string;
  history: ChatTurn[];
  maxOutput: number;
  apiKey: string;
  signal: AbortSignal;
  tools?: ToolDef[]; // folder tools, when the student connected a folder
}

export interface ImageArgs {
  model: ImageModel;
  prompt: string;
  apiKey: string;
  signal: AbortSignal;
}

export interface GeneratedImage {
  mime: string;
  bytes: Uint8Array;
}

export interface ProviderAdapter {
  id: ProviderId;
  stream(args: StreamArgs): AsyncIterable<StreamEvent>;
  generateImage?(args: ImageArgs): Promise<GeneratedImage>;
}

export function errorForStatus(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("auth", status);
  if (status === 429) return new ProviderError("rate_limit", status);
  if (status === 404) return new ProviderError("model_unavailable", status); // model id not available to this key
  if (status === 408 || status === 504) return new ProviderError("timeout", status);
  if (status >= 500) return new ProviderError("unavailable", status);
  if (status >= 400) return new ProviderError("bad_request", status);
  return new ProviderError("unknown", status);
}

/** Most chat APIs need strictly alternating turns that start with the user: merge repeats, drop a leading reply. */
export function normalizeTurns(history: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const t of history) {
    if (!t.content.trim() && !t.images?.length && !t.documents?.length && !t.toolCalls?.length && !t.toolResults?.length) continue;
    if (out.length === 0 && t.role === "assistant") continue;
    const last = out[out.length - 1];
    // Never merge across tool calls/results: each provider pairs them by position.
    const tooly = Boolean(t.toolCalls?.length || t.toolResults?.length || last?.toolCalls?.length || last?.toolResults?.length);
    if (last && last.role === t.role && !tooly) {
      last.content = [last.content, t.content].filter(Boolean).join("\n\n");
      if (t.images?.length) last.images = [...(last.images ?? []), ...t.images];
      if (t.documents?.length) last.documents = [...(last.documents ?? []), ...t.documents];
    } else out.push({ ...t, images: t.images ? [...t.images] : undefined, documents: t.documents ? [...t.documents] : undefined });
  }
  return out;
}

export function decodeBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Tool arguments arrive as JSON text from most providers; bad JSON becomes {} (the tool then reports what's missing). */
export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** JSON schema for a tool without our extra fields. */
export const toolSchema = (t: ToolDef) => ({ name: t.name, description: t.description, parameters: t.parameters });
