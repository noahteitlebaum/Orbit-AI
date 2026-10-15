import { xaiBillableOutput } from "./usage";
import { readSse } from "./sse";
import { decodeBase64, errorForStatus, normalizeTurns, parseArgs, ProviderError, toolSchema, type FinishReason, type ChatTurn, type ProviderAdapter } from "./types";

// xAI (OpenAI-compatible Chat Completions, streaming, function calling) + Imagine image generation.

function toMessages(t: ChatTurn): object[] {
  if (t.toolResults?.length) return t.toolResults.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.output }));
  if (t.toolCalls?.length) {
    return [{
      role: "assistant",
      content: t.content || null,
      tool_calls: t.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    }];
  }
  if (t.images?.length && t.role === "user") {
    return [{
      role: "user",
      content: [
        ...t.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } })),
        { type: "text", text: t.content || " " },
      ],
    }];
  }
  return [{ role: t.role, content: t.content }];
}
export const xai: ProviderAdapter = {
  id: "xai",

  async *stream({ model, system, history, maxOutput, apiKey, signal, tools, cacheKey }) {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(cacheKey ? { "x-grok-conv-id": cacheKey } : {}) },
      body: JSON.stringify({
        model: model.apiModel,
        messages: [
          { role: "system", content: system },
          ...normalizeTurns(history).flatMap(toMessages),
        ],
        ...(tools?.length ? { tools: tools.map((t) => ({ type: "function", function: toolSchema(t) })) } : {}),
        max_tokens: maxOutput,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });
    if (!res.ok || !res.body) throw errorForStatus(res.status);

    let finish:FinishReason|undefined;
    const calls = new Map<number, { id: string; name: string; args: string }>(); // streamed in pieces, keyed by index
    for await (const { data } of readSse(res.body)) {
      if (data === "[DONE]") break;
      const ev = JSON.parse(data);
      if (ev.error) throw new ProviderError("unavailable", undefined, true);
      const reason=ev.choices?.[0]?.finish_reason;
      if(reason) finish=reason==="length"?"length":reason==="content_filter"?"blocked":reason==="tool_calls"?"tool_calls":reason==="stop"?"stop":"unknown";
      const delta = ev.choices?.[0]?.delta?.content;
      if (delta) yield { delta: delta as string };
      for (const tc of ev.choices?.[0]?.delta?.tool_calls ?? []) {
        const i = typeof tc.index === "number" ? tc.index : calls.size;
        const c = calls.get(i) ?? { id: "", name: "", args: "" };
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
        calls.set(i, c);
      }
      if (ev.usage) {
        const reasoning = ev.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        yield {
          usage: {
            input: ev.usage.prompt_tokens ?? 0,
            // Aggregate tells us whether reasoning is already included, avoiding duplicate charges.
            output: xaiBillableOutput(ev.usage.prompt_tokens ?? 0, ev.usage.completion_tokens ?? 0, reasoning, ev.usage.total_tokens),
            reasoning,
            cached: ev.usage.prompt_tokens_details?.cached_tokens ?? 0,
          },
        };
      }
    }
    for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      yield { toolCall: { id: c.id || `call_${i}`, name: c.name, args: parseArgs(c.args) } };
    }
    if(finish) yield {finish};
    else throw new ProviderError("incomplete_stream",undefined,true);
  },

  async generateImage({ model, prompt, apiKey, signal }) {
    const res = await fetch("https://api.x.ai/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.apiModel, prompt, n: 1, response_format: "b64_json" }),
      signal,
    });
    if (!res.ok) throw errorForStatus(res.status);
    const json = await res.json();
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new ProviderError("unknown", res.status, true);
    return { mime: "image/jpeg", bytes: decodeBase64(b64) };
  },
};
