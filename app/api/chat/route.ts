import { CONTEXT } from "@/config/context";
import { trackEvent } from "@/lib/analytics/events";
import { retrieveRelevant } from "@/lib/chat/retrieval";
import { randomUUID, createHash } from "node:crypto";
import { FOLDER_ACCESS, PDF_INPUT, getModel, isProvider } from "@/config/models";
import { dbError, isUuid, json, requireAppUser } from "@/lib/api";
import { isProviderDisabled, overRateLimit, reserve, settle } from "@/lib/billing/budget";
import { buildEconomicContext, economicInputBudget, costMicros, estimateTokens, maxOutputFor, reservationMicros, STUDY_MODES, systemPrompt, type StudyMode } from "@/lib/chat/context";
import { citedSources, gatherMaterial, grounding, IMAGE_TOKENS, loadImages, MAX_IMAGES, stripInventedCitations, type Source } from "@/lib/chat/material";
import { SUMMARY_TOKENS, updateSummary } from "@/lib/chat/summary";
import { WEB_SEARCH } from "@/config/search";
import { domainOf, searchKey, searchQuery, webSearch, type WebResult } from "@/lib/search/web";
import { applyResults, mergeQuiz, parseQuiz, quizContext, type QuizState } from "@/lib/chat/quiz";
import { ADAPTERS, apiKeyFor, liveFor } from "@/lib/providers";
import { ProviderError, type ChatTurn, type StreamEvent, type ToolCall, type Usage } from "@/lib/providers/types";
import { FOLDER_TOOLS, folderPrompt, MAX_CALLS_PER_STEP, MAX_TOOL_STEPS } from "@/lib/folder/tools";
import { CODE_TOOLS, codePrompt } from "@/lib/code/tools";
import { loadPersonal, relevantMemories, parseRemember, personalPrompt, saveMemories, type Memory } from "@/lib/profile/personal";
import { parseSteps, stepTurns, toolLog, type Step } from "@/lib/folder/run";

// POST /api/chat — auth → ownership → gates → context (+ course material, images, summary) → reserve → stream → reconcile → save.
// Body: { provider, modelId, content, conversationId?, projectId?, retry?, attachmentIds?, mode?, courseOnly?, folder?, run? }
//   folder: { name } — the student connected a folder in the browser, so the model gets file tools.
//   voice: true — voice conversation: short, speakable answers (the browser reads them aloud).
//   code: true — the browser can run Python (lib/code/runner.ts), so the model gets run_python.
//   run: { replyId, steps } — continue a reply after the browser ran the model's tool calls (see lib/folder/run.ts).
// Response: newline-delimited JSON events: meta, delta…, then done (with cited sources), tool_calls (browser runs
// them, then calls again with run), or error.
export const maxDuration = 300;
/** Short, opaque cache scope per chat. OpenAI rejects prompt_cache_key values over 64 characters (two UUIDs are 79). */
const cacheKeyFor = (userId: string, conversationId: string) =>
  `orbit-${createHash("sha256").update(`${userId}:${conversationId}`).digest("base64url").slice(0, 32)}`;
const VOICE_MAX_OUTPUT = 1_200; // spoken answers are short; a smaller cap also means a smaller reservation

type Body = {
  provider?: unknown; homeProvider?: unknown; modelId?: unknown; content?: unknown; conversationId?: unknown; projectId?: unknown; retry?: unknown;
  attachmentIds?: unknown; mode?: unknown; courseOnly?: unknown; folder?: unknown; run?: unknown; web?: unknown; code?: unknown; voice?: unknown;
};
type Row = { id: string; seq: number; role: "user" | "assistant"; content: string; status: string; kind: string; attachment_ids: string[] | null; model_id: string | null };

const MAX_MESSAGE_CHARS = 32_000;
const MAX_ATTACHMENTS = 10;

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const { user, supabase } = auth;

  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body || !isProvider(body.provider)) return json({ error: "bad_request" }, 400);
  const provider = body.provider;
  if(body.homeProvider!==undefined && !isProvider(body.homeProvider)) return json({error:"bad_request"},400);
  const homeProvider = isProvider(body.homeProvider)?body.homeProvider:provider;
  const model = getModel(typeof body.modelId === "string" ? body.modelId : undefined);
  if (!model || !model.enabled || model.provider !== provider) return json({ error: "unknown_model" }, 400);
  const retry = body.retry === true;

  // ---- folder tools + tool-run continuation
  const folderName =
    FOLDER_ACCESS[provider] && body.folder && typeof body.folder === "object" && typeof (body.folder as { name?: unknown }).name === "string"
      ? (body.folder as { name: string }).name.replace(/[\r\n"]/g, " ").trim().slice(0, 100) || "folder"
      : null;
  let run: { replyId: string; steps: Step[] } | null = null;
  if (body.run !== undefined) {
    const r = body.run as { replyId?: unknown; steps?: unknown } | null;
    const steps = parseSteps(r?.steps);
    if (!r || !isUuid(r.replyId) || !steps || !isUuid(body.conversationId) || retry) return json({ error: "bad_request" }, 400);
    run = { replyId: r.replyId, steps };
  }
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter(isUuid).slice(0, MAX_ATTACHMENTS) : [];
  if (!run && !retry && !content && !attachmentIds.length) return json({ error: "empty_message" }, 400);
  if (content.length > MAX_MESSAGE_CHARS) return json({ error: "message_too_long" }, 400);

  // ---- conversation (RLS: only the user's own rows are visible or writable)
  let conversation: { id: string; title: string; provider: string; project_id: string | null; mode: string; course_only: boolean; summary: string | null; summary_upto: number | null };
  const convCols = "id, title, provider, project_id, mode, course_only, summary, summary_upto";
  if (isUuid(body.conversationId)) {
    const { data, error } = await supabase.from("conversations").select(convCols).eq("id", body.conversationId).maybeSingle();
    if (error) return dbError(error, "load_failed");
    if (!data) return json({ error: "not_found" }, 404);
    // Conversation owner/app is stable for the sidebar; generation provider may change explicitly.
    conversation = data;
  } else {
    if (retry) return json({ error: "bad_request" }, 400);
    const { data, error } = await supabase
      .from("conversations")
      .insert({ user_id: user.id, provider:homeProvider, model_id: model.id, title: (content || "Files").slice(0, 60), project_id: isUuid(body.projectId) ? body.projectId : null })
      .select(convCols)
      .single();
    if (error || !data) return dbError(error, "save_failed");
    conversation = data;
    await trackEvent(user.id,"conversation_created",{modelId:model.id,provider,live:liveFor(provider)},conversation.id,`conversation:${conversation.id}`);
  }

  // Study mode and "only use my course material" stick to the chat once set.
  const settings: Record<string, unknown> = { model_id: model.id, updated_at: new Date().toISOString() };
  if (typeof body.mode === "string" && (STUDY_MODES as string[]).includes(body.mode)) settings.mode = conversation.mode = body.mode;
  if (typeof body.courseOnly === "boolean") settings.course_only = conversation.course_only = body.courseOnly;
  await supabase.from("conversations").update(settings).eq("id", conversation.id);

  // ---- attachments: only the student's own, not-yet-used uploads; they now belong to this chat
  let linked: string[] = [];
  if (attachmentIds.length && !retry && !run) {
    const { data } = await supabase.from("files").select("id").in("id", attachmentIds).is("project_id", null).is("conversation_id", null);
    linked = (data ?? []).map((f) => f.id as string);
    if (linked.length) await supabase.from("files").update({ conversation_id: conversation.id }).in("id", linked);
  }

  // ---- the student's message (or, on retry, drop the failed reply and reuse the last question)
  let userMessageId: string;
  let priorText = ""; // reply text from earlier rounds of a tool run
  if (run) {
    const { data: msgs } = await supabase.from("messages").select("id, role, seq, content, model_id").eq("conversation_id", conversation.id).order("seq");
    const list = msgs ?? [];
    const reply = list.at(-1);
    const lastUser = [...list].reverse().find((m) => m.role === "user");
    // Only the newest reply can be continued.
    if (!reply || reply.id !== run.replyId || reply.role !== "assistant" || !lastUser || (reply.model_id && reply.model_id!==model.id)) return json({ error: "bad_request" }, 400);
    userMessageId = lastUser.id;
    priorText = reply.content ?? "";
  } else if (retry) {
    const { data: msgs } = await supabase.from("messages").select("id, role, seq").eq("conversation_id", conversation.id).eq("kind", "text").order("seq");
    const lastUser = [...(msgs ?? [])].reverse().find((m) => m.role === "user");
    if (!lastUser) return json({ error: "nothing_to_retry" }, 400);
    await supabase.from("messages").delete().eq("conversation_id", conversation.id).eq("role", "assistant").gt("seq", lastUser.seq);
    userMessageId = lastUser.id;
  } else {
    const { data, error } = await supabase
      .from("messages")
      .insert({ conversation_id: conversation.id, user_id: user.id, role: "user", content, attachment_ids: linked })
      .select("id")
      .single();
    if (error || !data) return dbError(error, "save_failed");
    userMessageId = data.id;
    await trackEvent(user.id,"message_sent",{modelId:model.id,provider,mode:conversation.mode,live:liveFor(provider)},conversation.id,`message:${data.id}`);
  }

  // Profile + memories load in parallel with the rest (they don't depend on it).
  const personalP = loadPersonal(supabase);
  const voice = body.voice === true; // voice conversation: quick, short, no tools

  // ---- history
  const { data: rawRows } = await supabase
    .from("messages")
    .select("id, seq, role, content, status, kind, attachment_ids, model_id")
    .eq("conversation_id", conversation.id)
    .order("seq");
  const rows = ((rawRows ?? []) as Row[]).filter(
    (m) => m.kind === "text" && m.status !== "error" && m.id !== run?.replyId && (m.content || m.attachment_ids?.length),
  );
  const history: ChatTurn[] = rows.map((m) => ({ role: m.role, content: m.content }));
  const previousModel = [...rows].reverse().find(m=>m.role==='assistant')?.model_id;
  if (!retry && !run && previousModel && previousModel!==model.id) await trackEvent(user.id,"model_switched",{modelId:model.id,provider},conversation.id,`switch:${userMessageId}`);
  const question = [...rows].reverse().find((m) => m.role === "user")?.content ?? content;

  // ---- course + material from files
  let project: { name: string; instructions: string } | null = null;
  if (conversation.project_id) {
    const { data } = await supabase.from("projects").select("name, instructions").eq("id", conversation.project_id).maybeSingle();
    project = data;
  }
  const imageCount = Math.min(MAX_IMAGES, rows.reduce((n, r) => n + (r.attachment_ids?.length ?? 0), 0));
  const material = await gatherMaterial(supabase, {
    conversationId: conversation.id, projectId: conversation.project_id, question,
    newAttachmentIds: retry ? rows.at(-1)?.attachment_ids ?? [] : linked,
    pdfInput: PDF_INPUT[provider], imageSlots: Math.max(0, MAX_IMAGES - imageCount),
    previousQuestion: rows.filter((m) => m.role === "user").at(-2)?.content,
  });

  const live = liveFor(provider);
  const requestId = randomUUID();
  let apiKey: string | null = null;
  if (live) {
    apiKey = apiKeyFor(provider);
    if (!apiKey) return json({ error: "not_configured", conversationId: conversation.id }, 503);
    if (await isProviderDisabled(provider)) return json({ error: "provider_disabled", conversationId: conversation.id }, 503);
    if (await overRateLimit(user.id)) return json({ error: "rate_limited", conversationId: conversation.id }, 429);
  }

  // ---- web search ("Search the web" on, not with "only my course material"). One search per question, charged like
  // any call, saved on the question so later turns and other models use the same results. web_results: migration 0007.
  type SavedSearch = { query: string; results: WebResult[]; at: string };
  let web: SavedSearch | null = null;
  const webNotes: string[] = [];
  const wantsWeb = body.web === true && !conversation.course_only;
  {
    const { data: saved, error: savedErr } = await supabase.from("messages").select("id, seq, role, web_results").eq("conversation_id", conversation.id).order("seq");
    if (!savedErr) {
      const asked = (saved ?? []).filter((m) => m.role === "user");
      const mine = asked.find((m) => m.id === userMessageId);
      // This question's search (a retry or a tool round), else the latest from the last two questions (a follow-up).
      const recent = asked.slice(-3).reverse().find((m) => m.web_results);
      web = ((mine?.web_results ?? (!wantsWeb ? recent?.web_results : null)) as SavedSearch | null) ?? null;
    }
  }
  if (wantsWeb && !web) {
    const key = searchKey();
    if (!live) webNotes.push("The student asked to search the web, but Orbit AI is in demo mode, so no search ran. Say so in one sentence.");
    else if (!key) webNotes.push("The student asked to search the web, but web search isn't set up yet (no search key). Say so in one sentence and answer from what you know, clearly marked as not from a search.");
    else {
      const previousQ = rows.filter((m) => m.role === "user").at(-2)?.content;
      const query = searchQuery(question, previousQ);
      const searchId = randomUUID();
      const cost = Math.ceil(WEB_SEARCH.pricePerSearch * 1_000_000);
      const r = await reserve(user.id, searchId, "web-search", "text", cost, {conversationId:conversation.id,provider:"tavily",operation:"search",unitCostUsdMicros:cost});
      if (!r.ok) return json({ error: r.reason === "budget" ? "budget" : r.reason === "global_stop" ? "paused" : "reserve_failed", conversationId: conversation.id }, r.reason === "budget" ? 402 : 503);
      try {
        const results = await webSearch(query, key);
        await settle(searchId, "settled", cost);
        web = { query, results, at: new Date().toISOString() };
        await supabase.from("messages").update({ web_results: web }).eq("id", userMessageId);
        if (!results.length) webNotes.push(`A web search for "${query}" found nothing. Say so, and answer from what you know, clearly marked as not from a search.`);
      } catch {
        await settle(searchId, "released", 0, undefined, "search_failed"); // a failed search isn't charged
        webNotes.push("The web search failed this time. Say so in one sentence, and answer from what you know, clearly marked as not from a search.");
      }
    }
  }
  const webSources: Source[] = (web?.results ?? []).map((w, i) => ({
    n: i + 1, kind: "web", url: w.url, fileId: "", fileName: domainOf(w.url), page: null,
    label: `${domainOf(w.url)} — ${w.title}`, excerpt: w.content.slice(0, 600),
  }));
  const webBlock = web && webSources.length
    ? `Web search results for "${web.query}" (searched ${web.at.slice(0, 10)}):\n` + (web.results.map((w, i) => `[W${i + 1}] ${w.title} — ${w.url}${w.published ? ` (published ${w.published.slice(0, 10)})` : ""}\n${w.content}`).join("\n\n"))
    : "";
  const allSources = [...material.sources, ...webSources];

  // ---- quiz progress (this chat + earlier quizzes in the course). quiz_state comes with migration 0006.
  let quizState: QuizState | null = null;
  let quizText = "";
  if (conversation.mode === "quiz") {
    const { data: q } = await supabase.from("conversations").select("quiz_state").eq("id", conversation.id).maybeSingle();
    quizState = (q?.quiz_state as QuizState | null) ?? null;
    let course: QuizState | null = null;
    if (conversation.project_id) {
      const { data: others } = await supabase.from("conversations").select("id, quiz_state").eq("project_id", conversation.project_id);
      course = mergeQuiz((others ?? []).filter((c) => c.id !== conversation.id).map((c) => c.quiz_state as QuizState | null));
    }
    quizText = quizContext(quizState, course);
  }

  // ---- the student's profile and saved memories (Settings; migration 0008)
  const personal = await personalP;
  const selectedMemories = relevantMemories(personal.memories, question);
  const promptBase = {
    modelLabel: model.label, personal: personalPrompt(personal.profile, selectedMemories), projectName: project?.name, projectInstructions: project?.instructions,
    mode: conversation.mode as StudyMode, quiz: quizText, material: material.block, courseOnly: conversation.course_only,
    hasFiles: material.hasFiles, unreadable: material.unreadable, notes: [...material.notes, ...webNotes], web: webBlock,
    voice,
  };
  const stepsUsed = run?.steps.length ?? 0;
  const codeOn = body.code === true;
  const offered = [...(codeOn ? CODE_TOOLS : []), ...(folderName ? FOLDER_TOOLS : [])];
  const tools = offered.length && stepsUsed < MAX_TOOL_STEPS && !voice ? offered : undefined;
  const runTurns = run ? stepTurns(run.steps) : [];
  const runTokens = runTurns.reduce((n, t) => n + estimateTokens(t.content + JSON.stringify(t.toolCalls ?? t.toolResults ?? "")), 0);
  const folderText = [codeOn && tools ? codePrompt(material.dataFiles) : "", folderName && !voice ? folderPrompt(folderName, MAX_TOOL_STEPS - stepsUsed) : ""].filter(Boolean).join("\n\n");
  const baseTokens = estimateTokens(systemPrompt(promptBase) + folderText) + imageCount * IMAGE_TOKENS + material.visualTokens + runTokens + (tools ? estimateTokens(JSON.stringify(tools)) + 400 : 0);
  const contextTarget = economicInputBudget(history, baseTokens + SUMMARY_TOKENS + CONTEXT.retrievalTokens,
    model.contextTokens - model.maxOutputTokens, Boolean(tools || material.hasFiles));
  const ctx = buildEconomicContext(history, Math.max(0, contextTarget - baseTokens - SUMMARY_TOKENS - CONTEXT.retrievalTokens));

  // ---- long chat: fold messages that no longer fit into a running summary (live only; charged like any call).
  // The summary is only sent when older messages are actually left out (a bigger model may see them all).
  let summary: string | null = null;
  if (ctx.dropped) {
    summary = conversation.summary;
    const droppedRows = rows.slice(0, rows.length - ctx.turns.length);
    if (live && apiKey) {
      const ids = [...new Set(droppedRows.flatMap((r) => r.attachment_ids ?? []))];
      const names = new Map<string, string>();
      if (ids.length) {
        const { data: f } = await supabase.from("files").select("id, name").in("id", ids);
        for (const x of f ?? []) names.set(x.id as string, x.name as string);
      }
      summary = await updateSummary({
        supabase, userId: user.id, conversationId: conversation.id, provider, apiKey,
        existing: conversation.summary, existingUpto: conversation.summary_upto,
        dropped: droppedRows.map((r) => ({ ...r, files: (r.attachment_ids ?? []).map((id) => names.get(id)).filter((n): n is string => Boolean(n)) })),
      });
    }
  }

  const keptIds = new Set(rows.slice(rows.length-ctx.turns.length).map(r=>r.id));
  const retrieval = live && (ctx.dropped || personal.memories.length>12) ? await retrieveRelevant({supabase,userId:user.id,conversationId:conversation.id,
    enabled:Boolean(personal.profile?.memory_enabled),query:question,excluded:new Set([...keptIds,...selectedMemories.map(m=>m.id)]),memories:personal.memories,
    sources:[...(summary ? [{id:conversation.id,kind:"summary" as const,content:summary}] : []),
      ...rows.filter(r=>!keptIds.has(r.id)).reverse().map(r=>({id:r.id,kind:"message" as const,content:r.content}))]}) : {block:"",count:0};
  if (retrieval.count) await trackEvent(user.id,"context_retrieved",{count:retrieval.count,live},conversation.id,`retrieved:${requestId}`);
  // Disclose incomplete summary coverage, including budget failures and gradual backlog processing.
  let summaryIncomplete = false;
  if (ctx.dropped) {
    const {data: checkpoint} = await supabase.from("conversations").select("summary_upto").eq("id",conversation.id).maybeSingle();
    const lastDropped = rows[rows.length-ctx.turns.length-1]?.seq;
    summaryIncomplete = lastDropped!=null && (checkpoint?.summary_upto==null || checkpoint.summary_upto<lastDropped);
  }

  // ---- images on the kept turns go to the vision model
  const keptRows = rows.slice(rows.length - ctx.turns.length);
  const images = await loadImages(supabase, keptRows.map((r, i) => ({ messageIndex: i, ids: r.attachment_ids ?? [] })).filter((m) => m.ids.length));
  // PDF pages to read visually and matching course images go with the question (the newest student message).
  const questionAt = ctx.turns.map((t) => t.role).lastIndexOf("user");
  const turns: ChatTurn[] = [
    ...ctx.turns.map((t, i) => {
      const withImages = images.has(i) ? { ...t, images: images.get(i) } : t;
      if (i !== questionAt || (!material.documents.length && !material.images.length)) return withImages;
      return { ...withImages, documents: material.documents, images: [...(withImages.images ?? []), ...material.images] };
    }),
    ...runTurns,
  ];

  const system = [systemPrompt({ ...promptBase, summary, retrieved:retrieval.block }), folderText].filter(Boolean).join("\n\n");
  // Tool definitions count as input too (~1.5k tokens for all of them).
  const inputTokens = ctx.tokens + runTokens + (tools ? estimateTokens(JSON.stringify(tools)) + 400 : 0) + estimateTokens(system) + [...images.values()].flat().length * IMAGE_TOKENS + material.visualTokens;

  if (inputTokens > Math.min(model.contextTokens-model.maxOutputTokens,CONTEXT.maximumInputTokens)) {
    return json({error:"context_too_large",conversationId:conversation.id},413);
  }
  const callMetadata = {conversationId:conversation.id,provider,operation:"chat" as const,inputEstimate:inputTokens,
    contextTarget,historyDropped:ctx.dropped,retrievedCount:retrieval.count};

  // ---- reservation (live only)
  let maxOutput = voice ? Math.min(model.maxOutputTokens, VOICE_MAX_OUTPUT) : model.maxOutputTokens;
  if (live) {
    let r = await reserve(user.id, requestId, model.id, "text", reservationMicros(model, inputTokens, maxOutput),callMetadata);
    if (!r.ok && r.reason === "budget" && r.remaining) {
      // Shrink the reply to fit what's left, if that still allows a useful answer.
      const fit = Math.min(maxOutput, maxOutputFor(model, inputTokens, r.remaining));
      if (fit >= 500) {
        maxOutput = fit;
        r = await reserve(user.id, requestId, model.id, "text", reservationMicros(model, inputTokens, maxOutput),callMetadata);
      }
    }
    if (!r.ok) {
      if(r.reason==="budget") await trackEvent(user.id,"allowance_exhausted",{modelId:model.id,provider,live},conversation.id);
      const code = r.reason === "global_stop" ? "paused" : ["budget","trial_expired","fx_not_configured"].includes(r.reason) ? r.reason : "reserve_failed";
      return json({ error: code, conversationId: conversation.id }, code === "budget" ? 402 : 503);
    }
  }

  // ---- placeholder reply row (a tool run keeps adding to the same one), then stream
  let replyId: string;
  if (run) {
    replyId = run.replyId;
    await supabase.from("messages").update({ model_id: model.id, status: "partial" }).eq("id", replyId);
  } else {
    const { data: replyRow } = await supabase
      .from("messages")
      .insert({ conversation_id: conversation.id, user_id: user.id, role: "assistant", content: "", model_id: model.id, status: "partial" })
      .select("id")
      .single();
    replyId = replyRow?.id ?? randomUUID();
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let clientGone = false;
      const send = (ev: object) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
        } catch {
          clientGone = true;
        }
      };
      request.signal.addEventListener("abort", () => (clientGone = true));

      send({
        t: "meta", conversationId: conversation.id, title: conversation.title, userMessageId, replyId, modelId: model.id,
        dropped: ctx.dropped, summaryIncomplete, summarized: Boolean(ctx.dropped && summary), mode: conversation.mode, courseOnly: conversation.course_only,
        attachmentIds: linked,
      });

      let text = priorText;
      let shown = priorText; // what the student actually saw (if they pressed Stop)
      let usage: Usage | undefined;
      const calls: ToolCall[] = [];
      let failure: ProviderError | null = null;
      try {
        const events = live
          ? ADAPTERS[provider].stream({ model, system, history: turns, maxOutput, apiKey: apiKey!, signal: AbortSignal.timeout(240_000), tools, fast: voice, cacheKey: cacheKeyFor(user.id, conversation.id) })
          : mockStream(model.label, history, ctx.dropped, allSources, conversation.mode);
        for await (const ev of events) {
          if (ev.delta) {
            // Later rounds of a tool run continue the same reply, as a new paragraph.
            const v = text && text === priorText && !/\s$/.test(text) ? `\n\n${ev.delta}` : ev.delta;
            text += v;
            if (!clientGone) shown = text;
            send({ t: "delta", v });
          }
          if (ev.toolCall && tools && calls.length < MAX_CALLS_PER_STEP) calls.push(ev.toolCall);
          if (ev.usage) usage = ev.usage;
          // If the student stopped, keep reading (server-side) so the provider reports real usage and we charge
          // the actual cost instead of the full reservation.
        }
      } catch (e) {
        failure = e instanceof ProviderError ? e : new ProviderError((e as Error)?.name === "TimeoutError" ? "timeout" : "unknown", undefined, true);
      }

      const stopped = clientGone && !failure;
      const finalText = stopped ? shown : text;
      const wantsTools = !failure && !stopped && calls.length > 0;
      const status = failure ? "error" : stopped || wantsTools ? "partial" : "complete";
      // References only point at passages that were really sent: made-up [S#] markers are removed from the saved text.
      // Quiz results: the server keeps the score; the marker lines are removed from the saved answer.
      // Memories: [[remember: …]] lines are saved (only when the student turned memory on) and removed from the answer.
      const remember = parseRemember(finalText);
      const quiz = conversation.mode === "quiz" ? parseQuiz(remember.clean) : null;
      const savedText = stripInventedCitations(quiz ? quiz.clean : remember.clean, allSources);
      const sources = citedSources(savedText, allSources);
      const ground = grounding(allSources, sources);
      await supabase.from("messages").update({ content: savedText, status, sources: ground === "none" ? null : sources }).eq("id", replyId);
      await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversation.id);
      if (quiz?.results.length && !failure) {
        quizState = applyResults(quizState, quiz.results);
        await supabase.from("conversations").update({ quiz_state: quizState }).eq("id", conversation.id);
      }
      let remembered: Memory[] = [];
      if (personal.profile?.memory_enabled && remember.saved.length && !failure) {
        remembered = await saveMemories(supabase, user.id, conversation.id, personal.memories, remember.saved);
      }
      // File activity shown under the reply (needs migration 0004; skipped quietly if it hasn't been run).
      if (run) await supabase.from("messages").update({ tool_log: toolLog(run.steps) }).eq("id", replyId);

      if (live) {
        if (usage) await settle(requestId, "settled", costMicros(model, usage), usage, failure?.code, {latencyMs:Date.now()-startedAt});
        else if (failure && !failure.started && text.length === priorText.length) await settle(requestId, "released", 0, undefined, failure.code);
        else await settle(requestId, "uncertain", 0, undefined, failure?.code ?? "no_usage");
      }

      await trackEvent(user.id,"response_completed",{modelId:model.id,provider,live,status,latencyMs:Date.now()-startedAt},conversation.id,`response:${requestId}`);
      for(const feature of [conversation.mode!=="chat"?conversation.mode:null,tools?.length?"tools":null,wantsWeb?"web_search":null].filter(Boolean)) {
        await trackEvent(user.id,"feature_used",{feature:feature!,provider,live},conversation.id,`feature:${requestId}:${feature}`);
      }
      if (failure) send({ t: "error", code: failure.code });
      else if (wantsTools) send({ t: "tool_calls", replyId, text: text.slice(priorText.length).trim(), calls });
      else send({ t: "done", status, sources, grounding: ground, content: savedText, ...(conversation.mode === "quiz" ? { quiz: quizState } : {}), ...(remembered.length ? { remembered } : {}) });
      try {
        controller.close();
      } catch {}
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Demo mode (LIVE_MODELS not "on"): a fake streamed reply, no provider call, no cost.
async function* mockStream(label: string, history: ChatTurn[], dropped: boolean, sources: Source[], mode: string): AsyncGenerator<StreamEvent> {
  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const reply =
    `(${label} demo reply${mode !== "chat" ? `, ${mode} mode` : ""}) You said: "${lastUser.slice(0, 200)}". ` +
    `This chat has ${history.length} message${history.length === 1 ? "" : "s"} of history` +
    (dropped ? ", but older ones didn't fit and weren't sent." : ".") +
    (sources.length ? ` I found ${sources.length} matching passage${sources.length === 1 ? "" : "s"} in your files, e.g. ${sources[0].label} [S1].` : "") +
    " Real answers appear once this app's API key is set and LIVE_MODELS=on.";
  for (const w of reply.split(/(\s+)/)) {
    await new Promise((r) => setTimeout(r, 15));
    yield { delta: w };
  }
}
