import { readSse } from "./sse";
import { decodeBase64, errorForStatus, normalizeTurns, parseArgs, ProviderError, toolSchema, type ChatTurn, type ProviderAdapter } from "./types";

// OpenAI Responses API (streaming, function calling) + Images API.

// One turn → Responses input items. Tool calls and results are their own items, paired by call_id.
function toInput(t: ChatTurn): object[] {
  if (t.toolResults?.length) return t.toolResults.map((r) => ({ type: "function_call_output", call_id: r.id, output: r.output }));
  const items: object[] = [];
  if ((t.images?.length || t.documents?.length) && t.role === "user") {
    items.push({
      role: "user",
      content: [
        ...(t.documents ?? []).map((d) => ({ type: "input_file", filename: d.name, file_data: `data:${d.mime};base64,${d.data}` })),
        ...(t.images ?? []).map((i) => ({ type: "input_image", image_url: `data:${i.mime};base64,${i.data}` })),
        { type: "input_text", text: t.content || " " },
      ],
    });
  } else if (t.content || !t.toolCalls?.length) items.push({ role: t.role, content: t.content });
  for (const c of t.toolCalls ?? []) items.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
  return items;
}
export const openai: ProviderAdapter = {
  id: "openai",

  async *stream({ model, system, history, maxOutput, apiKey, signal, tools, fast, cacheKey }) {
    const call = (lowEffort: boolean, useCacheKey = true) => fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(lowEffort ? { reasoning: { effort: "low" } } : {}),
        model: model.apiModel,
        instructions: system,
        input: normalizeTurns(history).flatMap(toInput),
        ...(tools?.length ? { tools: tools.map((t) => ({ type: "function", ...toolSchema(t), strict: false })) } : {}),
        max_output_tokens: maxOutput,
        stream: true,
        store: false,
        ...(cacheKey && useCacheKey ? { prompt_cache_key: cacheKey.slice(0, 64) } : {}),
      }),
      signal,
    });
    let res = await call(Boolean(fast));
    // A 400 can come from an optional setting this model doesn't accept: retry once with the plain request.
    if (res.status === 400 && (fast || cacheKey)) res = await call(false, false);
    if (!res.ok || !res.body) throw errorForStatus(res.status);

    for await (const { data } of readSse(res.body)) {
      if (data === "[DONE]") break;
      const ev = JSON.parse(data);
      if (ev.type === "response.output_text.delta" && ev.delta) yield { delta: ev.delta as string };
      else if (ev.type === "response.output_item.done" && ev.item?.type === "function_call") {
        yield { toolCall: { id: String(ev.item.call_id), name: String(ev.item.name), args: parseArgs(ev.item.arguments) } };
      }
      else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
        const u = ev.response?.usage;
        if (u) {
          yield {
            usage: {
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
              cached: u.input_tokens_details?.cached_tokens ?? 0,
              cacheWrite: u.input_tokens_details?.cache_write_tokens ?? 0,
            },
          };
        }
      } else if (ev.type === "response.failed" || ev.type === "error") {
        throw new ProviderError("unavailable", undefined, true);
      }
    }
  },

  async generateImage({ model, prompt, apiKey, signal }) {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.apiModel, prompt, n: 1, size: "1024x1024", quality: "medium" }), // medium keeps the flat price honest
      signal,
    });
    if (!res.ok) throw errorForStatus(res.status);
    const json = await res.json();
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new ProviderError("unknown", res.status, true);
    return { mime: "image/png", bytes: decodeBase64(b64) };
  },
};
