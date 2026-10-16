import type { ChatTurn, ToolCall, ToolResult } from "@/lib/providers/types";
import { isPluginTool, pluginLinks, type PluginLink } from "@/lib/plugins/catalog";
import { describeCall, isKnownTool, MAX_CALLS_PER_STEP, MAX_RESULT_CHARS, MAX_RUN_TOOL_CHARS, MAX_TOOL_STEPS } from "./tools";

// A "run" is one student message that the model answers in several rounds: it calls folder tools, the browser runs
// them on the student's folder (after the student approves any change), and sends the results back here.
// The browser holds the run's steps between requests; each request is a normal budgeted model call.

export type ResultStatus = "ok" | "declined" | "error";
export type StepResult = ToolResult & { status: ResultStatus };
export type Step = { text: string; calls: ToolCall[]; results: StepResult[] };
// code/output: for Python runs, so the code and what it printed are still there when the chat is reopened.
export type ToolLogEntry = { name: string; label: string; status: ResultStatus; code?: string; output?: string; links?: PluginLink[] };

const MAX_TEXT = 50_000;
const MAX_ARGS_CHARS = 100_000;
const STATUSES: ResultStatus[] = ["ok", "declined", "error"];
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

/** Validate the steps the browser sent back. Returns null if anything is malformed. */
export function parseSteps(raw: unknown): Step[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TOOL_STEPS) return null;
  const steps: Step[] = [];
  for (const s of raw) {
    if (!isObj(s) || typeof s.text !== "string" || s.text.length > MAX_TEXT) return null;
    if (!Array.isArray(s.calls) || !Array.isArray(s.results)) return null;
    if (s.calls.length === 0 || s.calls.length > MAX_CALLS_PER_STEP || s.results.length !== s.calls.length) return null;
    const calls: ToolCall[] = [];
    for (const c of s.calls) {
      if (!isObj(c) || !isId(c.id) || !isKnownTool(c.name) || !isObj(c.args)) return null;
      if (JSON.stringify(c.args).length > MAX_ARGS_CHARS) return null;
      const meta = isObj(c.meta)
        ? { thoughtSignature: typeof c.meta.thoughtSignature === "string" ? c.meta.thoughtSignature.slice(0, 20_000) : undefined, providerId: c.meta.providerId === true }
        : undefined;
      calls.push({ id: c.id, name: c.name as string, args: c.args, ...(meta ? { meta } : {}) });
    }
    const results: StepResult[] = [];
    for (let i = 0; i < s.results.length; i++) {
      const r = s.results[i];
      if (!isObj(r) || r.id !== calls[i].id || typeof r.output !== "string") return null;
      const status = STATUSES.includes(r.status as ResultStatus) ? (r.status as ResultStatus) : "error";
      const output = r.output.length > MAX_RESULT_CHARS ? `${r.output.slice(0, MAX_RESULT_CHARS)}\n[cut off]` : r.output;
      results.push({ id: calls[i].id, name: calls[i].name, output, status });
    }
    steps.push({ text: s.text, calls, results });
  }
  return steps;
}

/** Steps → turns for the model. Old outputs beyond the run's size cap are replaced (newest kept) to bound cost. */
export function stepTurns(steps: Step[]): ChatTurn[] {
  let budget = MAX_RUN_TOOL_CHARS;
  const keep = new Set<StepResult>();
  for (let i = steps.length - 1; i >= 0; i--) {
    for (const r of steps[i].results) {
      if (r.output.length <= budget) {
        keep.add(r);
        budget -= r.output.length;
      } else budget = 0;
    }
  }
  return steps.flatMap((s) => [
    { role: "assistant" as const, content: s.text, toolCalls: s.calls },
    {
      role: "user" as const,
      content: "",
      toolResults: s.results.map((r) => ({
        id: r.id, name: r.name,
        output: keep.has(r) ? r.output : "[Output removed to save space. Call the tool again if you still need it.]",
      })),
    },
  ]);
}

export function toolLog(steps: Step[]): ToolLogEntry[] {
  return steps.flatMap((s) =>
    s.calls.map((c, i) => ({
      name: c.name, label: describeCall(c.name, c.args), status: s.results[i].status,
      ...(c.name === "run_python" ? { code: String(c.args.code ?? "").slice(0, 20_000), output: s.results[i].output.slice(0, 8_000) } : {}),
      ...(isPluginTool(c.name) && s.results[i].status === "ok" ? (() => { const links = pluginLinks(c.name, s.results[i].output); return links.length ? { links } : {}; })() : {}),
    })),
  );
}
