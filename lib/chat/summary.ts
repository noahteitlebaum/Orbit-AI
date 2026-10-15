import { parseRemember } from "@/lib/profile/personal";
import { CONTEXT } from "@/config/context";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getModel, modelsFor, type ProviderId } from "@/config/models";
import { reserve, settle } from "@/lib/billing/budget";
import { ADAPTERS } from "@/lib/providers";
import type { Usage } from "@/lib/providers/types";
import { costMicros, reservationMicros, estimateTokens } from "./context";

// Long chats: messages that no longer fit are folded into a running summary (written by the app's cheapest
// model, charged to the student like any other call), so any model the student switches to still knows what
// happened earlier. Nothing is silently skipped: long messages are shortened, not dropped, and big backlogs are
// folded in several passes, oldest first.
export const SUMMARY_TOKENS = 1_500; // room kept for the summary in each request
const BATCH_CHARS = 40_000;          // transcript per summarizing call
const MAX_MESSAGE_CHARS = 6_000;     // a very long message keeps its start and end
const MAX_PASSES = 4;                // per request; anything left is folded in on the next message

export type SummaryMessage = { seq: number; role: string; content: string; model_id?: string | null; files?: string[] };

/** One transcript line: who said it (and which model answered), files attached, and the text. */
export function transcriptLine(m: SummaryMessage): string {
  const who = m.role === "user" ? "Student" : `Assistant (${getModel(m.model_id ?? undefined)?.label ?? "AI"})`;
  const files = m.files?.length ? ` [attached: ${m.files.join(", ")}]` : "";
  const content = parseRemember(m.content).clean;
  const text = content.length > MAX_MESSAGE_CHARS
    ? `${content.slice(0, MAX_MESSAGE_CHARS * 0.7)}\n[…shortened…]\n${content.slice(-MAX_MESSAGE_CHARS * 0.3)}`
    : content;
  return `${who}${files}: ${text}`;
}

/** Split messages into consecutive batches of at most BATCH_CHARS of transcript (each batch has ≥1 message). */
export function batches(msgs: SummaryMessage[]): SummaryMessage[][] {
  const out: SummaryMessage[][] = [];
  let cur: SummaryMessage[] = [];
  let size = 0;
  for (const m of msgs) {
    const len = transcriptLine(m).length;
    if (cur.length && size + len > BATCH_CHARS) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(m);
    size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

export async function updateSummary(o: {
  supabase: SupabaseClient;
  userId: string;
  conversationId: string;
  provider: ProviderId;
  apiKey: string;
  existing: string | null;
  existingUpto: number | null;
  dropped: SummaryMessage[]; // messages no longer sent, oldest first
}): Promise<string | null> {
  const fresh = o.existingUpto == null ? o.dropped : o.dropped.filter((m) => m.seq > o.existingUpto!);
  if (!fresh.length || (o.existing && fresh.length < CONTEXT.summaryRefreshMessages)) return o.existing;
  let summary = o.existing;
  for (const batch of batches(fresh).slice(0, MAX_PASSES)) {
    const next = await foldIn(o, summary, batch);
    if (next === null) break; // no budget or the call failed: keep what we have, try again next message
    summary = next;
    await o.supabase.from("conversations").update({ summary, summary_upto: batch[batch.length - 1].seq }).eq("id", o.conversationId);
  }
  return summary;
}

/** One summarizing call: the current summary plus a batch of messages → the new summary (null if it didn't work). */
async function foldIn(
  o: { userId: string; provider: ProviderId; apiKey: string },
  existing: string | null,
  batch: SummaryMessage[],
): Promise<string | null> {
  const model = [...modelsFor(o.provider)].sort((a, b) => a.outputPrice - b.outputPrice)[0];
  const transcript = batch.map(transcriptLine).join("\n\n");
  const prompt =
    (existing ? `Current summary:\n${existing}\n\n` : "") +
    `New earlier messages to fold in:\n${transcript}\n\n` +
    "Write an updated structured summary (max 300 words) with these headings:\n" +
    "Goal — what the student is working on (course, assignment).\n" +
    "Key facts & decisions — definitions, numbers, formulas, answers agreed on, anything the student asked to remember.\n" +
    "Files & sources — files the student attached and what they contain, as far as the messages show.\n" +
    "Work done so far — what's been explained, solved or written, and by which model if it matters.\n" +
    "Open questions — what's unresolved or the student wants to do next.\n" +
    "Keep everything from the current summary that still matters. Output only the summary.";
  const system = "You summarize study conversations so another assistant can continue them.";
  const maxOutput = 700;
  const requestId = crypto.randomUUID();
  const r = await reserve(o.userId, requestId, model.id, "summary", reservationMicros(model, estimateTokens(prompt + system), maxOutput));
  if (!r.ok) return null; // no budget for a summary: carry on without updating it

  let text = "";
  let usage: Usage | undefined;
  try {
    for await (const ev of ADAPTERS[o.provider].stream({
      model, system, maxOutput, apiKey: o.apiKey, signal: AbortSignal.timeout(60_000),
      history: [{ role: "user", content: prompt }],
    })) {
      if (ev.delta) text += ev.delta;
      if (ev.usage) usage = ev.usage;
    }
  } catch {
    await settle(requestId, text ? "uncertain" : "released", 0, undefined, "summary_failed");
    return null;
  }
  if (usage) await settle(requestId, "settled", costMicros(model, usage), usage);
  else await settle(requestId, "uncertain", 0, undefined, "no_usage");
  return estimateTokens(text) <= SUMMARY_TOKENS ? text.trim() || null : null;
}
