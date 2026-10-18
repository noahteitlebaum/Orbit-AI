import { estimateTokens } from "./context";
import type { Step } from "@/lib/folder/run";
import type { ChatTurn } from "@/lib/providers/types";

/** Include serialized call arguments, result escaping and provider metadata in the shared input allowance. */
export function toolTurnTokens(turns: ChatTurn[]): number {
  return turns.reduce((total, turn) => total + estimateTokens(JSON.stringify(turn)), 0);
}

function excerpt(text: string, keepChars: number, notice: string): string {
  const marker = `\n[${notice}]\n`;
  // Never inflate a short/error result into a longer omission notice.
  if (text.length <= keepChars + marker.length) return text;
  const head = Math.ceil(keepChars * 0.7);
  const tail = keepChars - head;
  return text.slice(0, head) + marker + (tail ? text.slice(-tail) : "");
}

/** Fit evidence to the request, rather than applying an unrelated character limit.
 * Calls/results stay paired. Arguments/signatures are never rewritten. No extra model call or spending.
 * Earlier complete rounds may be omitted only when their framing alone cannot fit; this is disclosed.
 */
export function fitToolContext(steps: Step[], budgetTokens: number): { turns: ChatTurn[]; tokens: number; compacted: boolean } | null {
  if (!steps.length) return { turns: [], tokens: 0, compacted: false };
  let selected = steps;
  function render(keepChars: number): ChatTurn[] {
    return selected.flatMap((step, index) => [
      {
        role: "assistant" as const,
        content: (index === 0 && selected.length < steps.length ? "[Earlier tool rounds omitted from this request. Re-read sources if needed.]\n" : "") +
          excerpt(step.text, keepChars, "Earlier assistant text excerpt; text omitted"),
        toolCalls: step.calls,
      },
      {
        role: "user" as const, content: "",
        toolResults: step.results.map((result) => ({ id: result.id, name: result.name,
          output: excerpt(result.output, keepChars, `${result.status}; source excerpt, middle omitted to fit this request. Use narrower file line ranges if more evidence is needed; do not claim the entire source was read`),
        })),
      },
    ]);
  }
  let full = render(Number.MAX_SAFE_INTEGER);
  if (toolTurnTokens(full) <= budgetTokens) return { turns: full, tokens: toolTurnTokens(full), compacted: false };
  // Preserve the latest complete round, including all call/result IDs and original provider metadata.
  while (selected.length > 1 && toolTurnTokens(render(0)) > budgetTokens) selected = selected.slice(1);
  if (toolTurnTokens(render(0)) > budgetTokens) return null;
  let low = 0;
  let high = Math.max(...selected.flatMap((s) => [s.text.length, ...s.results.map((r) => r.output.length)]));
  // The estimator sees the actual serialized payload, including escaped newlines, quotes and backslashes.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (toolTurnTokens(render(mid)) <= budgetTokens) low = mid;
    else high = mid - 1;
  }
  full = render(low);
  return { turns: full, tokens: toolTurnTokens(full), compacted: true };
}
