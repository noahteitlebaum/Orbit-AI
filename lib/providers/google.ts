import { readSse } from "./sse";
import { decodeBase64, errorForStatus, normalizeTurns, parseArgs, ProviderError, toolSchema, type ChatTurn, type ProviderAdapter } from "./types";

// Gemini API (streamGenerateContent over SSE) + native image generation.
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function toContent(t: ChatTurn) {
  if (t.toolResults?.length) {
    return {
      role: "user",
      parts: t.toolResults.map((r) => ({ functionResponse: { name: r.name, response: { output: r.output } } })),
    };
  }
  if (t.toolCalls?.length) {
    return {
      role: "model",
      parts: [
        ...(t.content.trim() ? [{ text: t.content }] : []),
        ...t.toolCalls.map((c) => ({
          functionCall: { name: c.name, args: c.args, ...(c.meta?.providerId ? { id: c.id } : {}) },
          ...(c.meta?.thoughtSignature ? { thoughtSignature: c.meta.thoughtSignature } : {}),
        })),
      ],
    };
  }
  return {
    role: t.role === "assistant" ? "model" : "user",
    parts: [
      ...(t.documents ?? []).map((d) => ({ inlineData: { mimeType: d.mime, data: d.data } })),
      ...(t.images ?? []).map((i) => ({ inlineData: { mimeType: i.mime, data: i.data } })),
      { text: t.content || " " },
    ],
  };
}

export const google: ProviderAdapter = {
  id: "google",

  async *stream({ model, system, history, maxOutput, apiKey, signal, tools, fast }) {
    const call = (lowThinking: boolean) => fetch(`${BASE}/${encodeURIComponent(model.apiModel)}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: normalizeTurns(history).map(toContent),
        ...(tools?.length ? { tools: [{ functionDeclarations: tools.map(toolSchema) }] } : {}),
        generationConfig: { maxOutputTokens: maxOutput, ...(lowThinking ? { thinkingConfig: { thinkingLevel: "low" } } : {}) },
      }),
      signal,
    });
    let res = await call(Boolean(fast));
    if (fast && res.status === 400) res = await call(false); // a model without thinking settings: ask normally
    if (!res.ok || !res.body) throw errorForStatus(res.status);

    let usage: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number } | undefined;
    let n = 0;
    for await (const { data } of readSse(res.body)) {
      const ev = JSON.parse(data);
      if (ev.error) throw new ProviderError("unavailable", ev.error.code, true);
      for (const part of ev.candidates?.[0]?.content?.parts ?? []) {
        if (part.functionCall) {
          // Gemini 3 requires the thought signature to be sent back with the call, or the next request fails.
          const fc = part.functionCall;
          n++;
          yield {
            toolCall: {
              id: fc.id ? String(fc.id) : `call_${n}_${Date.now().toString(36)}`, name: String(fc.name), args: parseArgs(fc.args),
              meta: { thoughtSignature: part.thoughtSignature, providerId: Boolean(fc.id) },
            },
          };
        } else if (part.text && !part.thought) yield { delta: part.text as string };
      }
      if (ev.usageMetadata) usage = ev.usageMetadata; // cumulative; the last one wins
    }
    if (usage) {
      const thoughts = usage.thoughtsTokenCount ?? 0;
      yield {
        usage: {
          input: usage.promptTokenCount ?? 0,
          output: (usage.candidatesTokenCount ?? 0) + thoughts, // thinking is billed as output
          reasoning: thoughts,
          cached: usage.cachedContentTokenCount ?? 0,
        },
      };
    }
  },

  async generateImage({ model, prompt, apiKey, signal }) {
    const res = await fetch(`${BASE}/${encodeURIComponent(model.apiModel)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      signal,
    });
    if (!res.ok) throw errorForStatus(res.status);
    const json = await res.json();
    const part = (json.candidates?.[0]?.content?.parts ?? []).find((p: { inlineData?: unknown }) => p.inlineData);
    if (!part) throw new ProviderError("bad_request", res.status, true); // usually a safety refusal
    return { mime: part.inlineData.mimeType ?? "image/png", bytes: decodeBase64(part.inlineData.data) };
  },
};
