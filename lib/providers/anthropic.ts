import { readSse } from "./sse";
import { errorForStatus, normalizeTurns, parseArgs, ProviderError, type FinishReason, type ChatTurn, type ProviderAdapter } from "./types";

// Anthropic Messages API (streaming, tool use). Claude has no image generation.

function toMessage(t: ChatTurn) {
  if (t.toolResults?.length) {
    return { role: "user", content: t.toolResults.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.output || "(empty)" })) };
  }
  if (t.toolCalls?.length) {
    return {
      role: "assistant",
      content: [
        ...(t.content.trim() ? [{ type: "text", text: t.content }] : []),
        ...t.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args })),
      ],
    };
  }
  if ((t.images?.length || t.documents?.length) && t.role === "user") {
    return {
      role: "user",
      content: [
        ...(t.documents ?? []).map((d) => ({ type: "document", title: d.name, source: { type: "base64", media_type: d.mime, data: d.data } })),
        ...(t.images ?? []).map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })),
        { type: "text", text: t.content || " " },
      ],
    };
  }
  return { role: t.role, content: t.content };
}
export const anthropic: ProviderAdapter = {
  id: "anthropic",

  async *stream({ model, system, history, maxOutput, apiKey, signal, tools, cacheKey }) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: model.apiModel,
        max_tokens: maxOutput,
        system,
        ...(cacheKey ? { cache_control: { type: "ephemeral" } } : {}),
        messages: normalizeTurns(history).map(toMessage),
        ...(tools?.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
        stream: true,
      }),
      signal,
    });
    if (!res.ok || !res.body) throw errorForStatus(res.status);

    let input = 0;
    let cached = 0;
    let cacheWrite = 0;
    let output = 0;
    let finish:FinishReason="unknown";
    const blocks = new Map<number, { id: string; name: string; json: string }>(); // tool_use blocks being streamed
    for await (const { data } of readSse(res.body)) {
      const ev = JSON.parse(data);
      switch (ev.type) {
        case "message_start": {
          const u = ev.message?.usage ?? {};
          cached = u.cache_read_input_tokens ?? 0;
          cacheWrite = u.cache_creation_input_tokens ?? 0;
          input = (u.input_tokens ?? 0) + cached + cacheWrite;
          output = u.output_tokens ?? 0;
          break;
        }
        case "content_block_start":
          if (ev.content_block?.type === "tool_use") blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: "" });
          break;
        case "content_block_delta":
          if (ev.delta?.type === "text_delta" && ev.delta.text) yield { delta: ev.delta.text as string };
          else if (ev.delta?.type === "input_json_delta") {
            const b = blocks.get(ev.index);
            if (b) b.json += ev.delta.partial_json ?? "";
          }
          break;
        case "content_block_stop": {
          const b = blocks.get(ev.index);
          if (b) {
            blocks.delete(ev.index);
            yield { toolCall: { id: b.id, name: b.name, args: parseArgs(b.json) } };
          }
          break;
        }
        case "message_delta":
          if (ev.usage?.output_tokens != null) output = ev.usage.output_tokens;
          if(ev.delta?.stop_reason) finish=ev.delta.stop_reason==="max_tokens"?"length":ev.delta.stop_reason==="refusal"?"blocked":ev.delta.stop_reason==="tool_use"?"tool_calls":["end_turn","stop_sequence"].includes(ev.delta.stop_reason)?"stop":"unknown";
          break;
        case "message_stop":
          yield { usage: { input, output, reasoning: 0, cached, cacheWrite, reasoningReported: false } };
          yield {finish};
          return;
        case "error":
          throw new ProviderError(ev.error?.type === "overloaded_error" ? "unavailable" : "unknown", undefined, true);
      }
    }
    throw new ProviderError("incomplete_stream",undefined,true);
  },
};
