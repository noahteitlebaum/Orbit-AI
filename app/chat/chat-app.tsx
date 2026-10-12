"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { FOLDER_ACCESS, IMAGE_MODELS, PROVIDERS, defaultModelFor, getModel, modelsFor, type ProviderId } from "@/config/models";
import { THEMES } from "@/config/themes";
import { missedConcepts, type QuizState } from "@/lib/chat/quiz";
import { answersLeft, answersText, isLow, timesCheaper, typicalAnswerMicros } from "@/lib/billing/estimate";
import { signOut } from "../login/actions";
import { ProviderLogo } from "@/components/provider-logo";
import { ModelMenu } from "@/components/model-menu";
import { ToolsMenu, type StudyMode } from "@/components/tools-menu";
import { ProjectDialog } from "@/components/project-dialog";
import { FileChip } from "@/components/file-chip";
import { AnswerText, SourceList, type Source } from "@/components/answer-text";
import { ACCEPT_ATTR, fileNote, uploadFile, type UploadedFile } from "@/lib/files/upload-client";
import { FolderDialog } from "@/components/folder-dialog";
import { FolderActivity, previewFor, type Activity } from "@/components/folder-activity";
import { loadApprovalMode, loadFolder, permission, runFolderTool, saveApprovalMode, saveFolder, type ApprovalMode, type FolderLink } from "@/lib/folder/browser-fs";
import { describeCall, isFolderTool, isWriteTool } from "@/lib/folder/tools";
import type { Step, StepResult, ToolLogEntry } from "@/lib/folder/run";
import type { ToolCall } from "@/lib/providers/types";

// Chats, projects and usage live in Supabase (see app/api/*). Each AI app has its own chats and projects.
type Message = {
  id: string;
  role: "user" | "assistant";
  kind: "text" | "image";
  content: string;
  imageUrl?: string | null;
  modelId?: string;
  status: "complete" | "partial" | "streaming" | "error";
  error?: string; // friendly error text for a failed reply
  attachments?: { id: string; name: string; kind: string; status: string; error?: string | null; project_id?: string | null }[];
  sources?: Source[];
  activity?: Activity[]; // file actions in the connected folder
  toolLog?: ToolLogEntry[]; // saved file actions, as loaded from the server
};
type Pending = { key: string; file?: UploadedFile; name: string; uploading: boolean; error?: string };
type ChatSettings = { mode: StudyMode; courseOnly: boolean; web?: boolean; summarized?: boolean; quiz?: QuizState | null };
type ConvSummary = { id: string; title: string; modelId: string; projectId: string | null; updatedAt: string };
type Project = { id: string; name: string; instructions: string };
type Usage = { live: boolean; liveProviders?: ProviderId[]; allowance: number; spent: number; reserved: number; typical?: Record<string, number> };

const APP_KEY = "polar.app.v1";
const DRAFT = "draft"; // messages key for a chat that hasn't been saved yet
const tmpId = () => `tmp-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const perProvider = <T,>(v: () => T) => Object.fromEntries(PROVIDERS.map((p) => [p, v()])) as Record<ProviderId, T>;
const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

function errorText(code: string, label: string, appName: string): string {
  switch (code) {
    case "budget": return `You don't have enough budget left for a ${label} answer, so this reply was paused. Your chat is saved.`;
    case "paused": return "Orbit AI is paused by the team right now. Your chat is saved — try again later.";
    case "rate_limited": return "That's a lot of messages in a minute. Wait a moment, then try again.";
    case "not_configured": return `${label} isn't set up yet (missing API key or price).`;
    case "provider_disabled": return `${appName} is turned off by the team right now. Try another app on the left.`;
    case "no_image_model": return `${appName} can't make images.`;
    case "message_too_long": return "That message is too long. Try splitting it up.";
    case "model_unavailable": return `${label} isn't available on this API key. Pick another model in the menu.`;
    case "auth": return `${appName} rejected the API key. It may have expired or been revoked.`;
    case "rate_limit": return `${appName} is rate-limiting us or the API account is out of credit. Try again shortly.`;
    case "reserve_failed": return "Couldn't check your budget. Make sure the database migrations have been run.";
    case "db_setup": return "The database isn't fully set up yet. Run every file in supabase/migrations in order in the Supabase SQL Editor.";
    case "bad_request": return `${label} couldn't handle that request.`;
    default: return `${label} didn't respond. Your chat is saved.`;
  }
}

export function ChatApp({ email, userId }: { email: string; userId: string }) {
  const router = useRouter();
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [convs, setConvs] = useState<Record<ProviderId, ConvSummary[] | null>>(() => perProvider<ConvSummary[] | null>(() => null));
  const [projects, setProjects] = useState<Record<ProviderId, Project[]>>(() => perProvider<Project[]>(() => []));
  const [activeIds, setActiveIds] = useState<Record<ProviderId, string | null>>(() => perProvider<string | null>(() => null));
  const [projectFilter, setProjectFilter] = useState<Record<ProviderId, string | null>>(() => perProvider<string | null>(() => null));
  const [draftModels, setDraftModels] = useState<Record<ProviderId, string>>(() =>
    Object.fromEntries(PROVIDERS.map((p) => [p, defaultModelFor(p)])) as Record<ProviderId, string>,
  );
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [dropped, setDropped] = useState<Record<string, boolean>>({});
  const [input, setInput] = useState("");
  const [imageMode, setImageMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [ready, setReady] = useState(false); // saved app choice restored
  const [projectDialog, setProjectDialog] = useState<null | { editing?: Project }>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]); // files attached to the next message
  const [settings, setSettings] = useState<Record<string, ChatSettings>>({});
  const [courseFiles, setCourseFiles] = useState<Record<string, UploadedFile[]>>({});
  const [courseUploading, setCourseUploading] = useState<string[]>([]);
  const [folder, setFolder] = useState<FolderLink | null>(null); // folder the student connected (browser folder access)
  const [folderOnline, setFolderOnline] = useState(false); // false = the browser wants permission again
  const [folderDialog, setFolderDialog] = useState(false);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("ask"); // read from storage after mount
  const approvals = useRef(new Map<string, (approve: boolean) => void>()); // file changes waiting for Apply / Skip
  const fileInput = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const theme = THEMES[provider];
  const appConvs = convs[provider];
  const filter = projectFilter[provider];
  const visibleConvs = (appConvs ?? []).filter((c) => !filter || c.projectId === filter);
  const activeId = activeIds[provider];
  const active = appConvs?.find((c) => c.id === activeId) ?? null;
  const msgKey = active ? active.id : `${DRAFT}:${provider}`;
  const thread = messages[msgKey] ?? [];
  const modelId = getModel(active?.modelId)?.provider === provider ? active!.modelId : draftModels[provider];
  const currentModel = getModel(modelId);
  const empty = thread.length === 0;
  const chatSettings: ChatSettings = settings[msgKey] ?? { mode: "chat", courseOnly: false };
  const setChatSettings = (patch: Partial<ChatSettings>) => setSettings((prev) => ({ ...prev, [msgKey]: { ...chatSettings, ...patch } }));
  const activeProject = projects[provider].find((p) => p.id === (active?.projectId ?? filter)) ?? null;
  const imageModel = IMAGE_MODELS[provider];

  // ---------------------------------------------------------------- loading
  const handleAuth = useCallback((res: Response) => {
    if (res.status === 401 || res.status === 403 || res.redirected) {
      router.replace("/");
      router.refresh();
      return true;
    }
    return false;
  }, [router]);

  const loadUsage = useCallback(async () => {
    const res = await fetch("/api/usage").catch(() => null);
    if (res?.ok) setUsage(await res.json());
  }, []);

  useEffect(() => {
    let saved: ProviderId = "openai";
    try {
      const v = localStorage.getItem(APP_KEY) as ProviderId | null;
      if (v && PROVIDERS.includes(v)) saved = v;
    } catch {}
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProvider(saved);
    setReady(true);
    loadUsage();
    setApprovalMode(loadApprovalMode());
    // The connected folder is remembered; the browser may want the student to allow it again (asked on next send).
    loadFolder().then(async (link) => {
      if (!link) return;
      setFolder(link);
      setFolderOnline((await permission(link.handle, false)) === "granted");
    });
  }, [loadUsage]);

  useEffect(() => {
    // Wait until the saved choice is restored, or we'd overwrite it (React runs effects twice in dev).
    if (!ready) return;
    try {
      localStorage.setItem(APP_KEY, provider);
    } catch {}
    if (convs[provider] !== null) return;
    (async () => {
      const [c, p] = await Promise.all([
        fetch(`/api/conversations?provider=${provider}`).catch(() => null),
        fetch(`/api/projects?provider=${provider}`).catch(() => null),
      ]);
      if (c && handleAuth(c)) return;
      const list: ConvSummary[] = c?.ok ? (await c.json()).conversations : [];
      const projs: Project[] = p?.ok ? (await p.json()).projects : [];
      for (const r of [c, p]) {
        if (r && !r.ok) {
          const e = (await r.clone().json().catch(() => ({}))) as { message?: string };
          alertLine(e.message ?? "Couldn't load your chats and courses. Refresh to try again.");
          break;
        }
      }
      setConvs((prev) => ({ ...prev, [provider]: list }));
      setProjects((prev) => ({ ...prev, [provider]: projs }));
      setActiveIds((prev) => (prev[provider] ? prev : { ...prev, [provider]: list[0]?.id ?? null }));
    })();
  }, [ready, provider, convs, handleAuth]);

  // Load an opened chat's messages once.
  useEffect(() => {
    if (!active || messages[active.id]) return;
    const id = active.id;
    (async () => {
      const res = await fetch(`/api/conversations/${id}`).catch(() => null);
      if (!res || handleAuth(res) || !res.ok) return;
      const out = (await res.json()) as { messages: Message[]; mode?: StudyMode; courseOnly?: boolean; summarized?: boolean; quiz?: QuizState | null };
      const withActivity = out.messages.map((m) =>
        m.toolLog?.length ? { ...m, activity: m.toolLog.map((t, i) => ({ id: `${m.id}-${i}`, name: t.name, label: t.label, status: t.status })) } : m,
      );
      setMessages((prev) => (prev[id] ? prev : { ...prev, [id]: withActivity }));
      setSettings((prev) => (prev[id] ? prev : { ...prev, [id]: { mode: out.mode ?? "chat", courseOnly: Boolean(out.courseOnly), summarized: out.summarized, quiz: out.quiz } }));
    })();
  }, [active, messages, handleAuth]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, msgKey]);

  // ---------------------------------------------------------------- helpers
  const patchMessages = (key: string, fn: (m: Message[]) => Message[]) =>
    setMessages((prev) => ({ ...prev, [key]: fn(prev[key] ?? []) }));

  const setActive = (id: string | null) => setActiveIds((prev) => ({ ...prev, [provider]: id }));

  function adoptConversation(newId: string, title: string, fromKey: string) {
    setMessages((prev) => {
      const next = { ...prev, [newId]: prev[fromKey] ?? [] };
      if (fromKey !== newId) delete next[fromKey];
      return next;
    });
    setSettings((prev) => ({ ...prev, [newId]: prev[fromKey] ?? prev[newId] ?? { mode: "chat", courseOnly: false } }));
    setConvs((prev) => {
      const list = prev[provider] ?? [];
      const existing = list.find((c) => c.id === newId);
      const summary: ConvSummary = existing
        ? { ...existing, modelId, updatedAt: new Date().toISOString() }
        : { id: newId, title, modelId, projectId: filter, updatedAt: new Date().toISOString() };
      return { ...prev, [provider]: [summary, ...list.filter((c) => c.id !== newId)] };
    });
    setActive(newId);
  }

  async function setModel(id: string) {
    if (getModel(id)?.provider !== provider) return;
    if (active) {
      setConvs((prev) => ({ ...prev, [provider]: (prev[provider] ?? []).map((c) => (c.id === active.id ? { ...c, modelId: id } : c)) }));
      fetch(`/api/conversations/${active.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelId: id }) });
    } else setDraftModels((prev) => ({ ...prev, [provider]: id }));
  }

  function pickProvider(p: ProviderId) {
    if (busy) return;
    setProvider(p);
    setInput("");
    setImageMode(false);
    setPending([]);
    setSidebarOpen(false);
  }

  function newChat() {
    setActive(null);
    setMessages((prev) => ({ ...prev, [`${DRAFT}:${provider}`]: [] }));
    setSettings((prev) => ({ ...prev, [`${DRAFT}:${provider}`]: { mode: "chat", courseOnly: false } }));
    setPending([]);
    setSidebarOpen(false);
  }

  async function deleteChat(id: string) {
    const res = await fetch(`/api/conversations/${id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) return;
    setConvs((prev) => ({ ...prev, [provider]: (prev[provider] ?? []).filter((c) => c.id !== id) }));
    if (activeId === id) setActive(null);
  }

  async function renameChat(id: string, title: string) {
    setRenaming(null);
    const t = title.trim();
    if (!t) return;
    setConvs((prev) => ({ ...prev, [provider]: (prev[provider] ?? []).map((c) => (c.id === id ? { ...c, title: t } : c)) }));
    await fetch(`/api/conversations/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: t }) });
  }

  async function moveToProject(id: string, projectId: string | null) {
    const res = await fetch(`/api/conversations/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) });
    if (!res.ok) alertLine("Couldn't move the chat. Make sure migration 0002 has been run.");
    else setConvs((prev) => ({ ...prev, [provider]: (prev[provider] ?? []).map((c) => (c.id === id ? { ...c, projectId } : c)) }));
  }

  function selectCourse(id: string | null) {
    setProjectFilter((prev) => ({ ...prev, [provider]: id }));
    if (id) {
      newChat();
      if (!courseFiles[id]) loadCourseFiles(id);
    }
    setSidebarOpen(false);
  }

  function openCourse(p: Project) {
    setProjectDialog({ editing: p });
    loadCourseFiles(p.id);
  }

  async function saveProject(v: { name: string; instructions: string }) {
    const editing = projectDialog?.editing;
    const res = await fetch(editing ? `/api/projects/${editing.id}` : "/api/projects", {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing ? v : { ...v, provider }),
    });
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { message?: string };
      alertLine(e.message ?? "Couldn't save the course. Try again.");
      return;
    }
    const { project } = (await res.json()) as { project: Project };
    // Each app has its own courses.
    setProjects((prev) => ({
      ...prev,
      [provider]: editing ? (prev[provider] ?? []).map((p) => (p.id === project.id ? project : p)) : [project, ...(prev[provider] ?? [])],
    }));
    if (!editing) {
      setProjectFilter((prev) => ({ ...prev, [provider]: project.id }));
      newChat();
      // Keep the dialog open on the new course so files can be added right away.
      openCourse(project);
      return;
    }
    setProjectDialog(null);
  }

  async function deleteProject(id: string) {
    const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
    if (!res.ok) {
      alertLine("Couldn't delete the course. Try again.");
      return;
    }
    setProjects((prev) => Object.fromEntries(PROVIDERS.map((pv) => [pv, prev[pv].filter((p) => p.id !== id)])) as Record<ProviderId, Project[]>);
    setConvs((prev) => ({ ...prev, [provider]: (prev[provider] ?? []).map((c) => (c.projectId === id ? { ...c, projectId: null } : c)) }));
    setProjectFilter((prev) => ({ ...prev, [provider]: null }));
    setProjectDialog(null);
  }

  // ---------------------------------------------------------------- files
  async function attachFiles(list: File[]) {
    for (const f of list.slice(0, 10)) {
      const key = tmpId();
      setPending((prev) => [...prev, { key, name: f.name, uploading: true }]);
      const out = await uploadFile(f, userId);
      setPending((prev) => prev.map((x) => (x.key !== key ? x : !("id" in out) ? { ...x, uploading: false, error: out.error } : { ...x, uploading: false, file: out })));
    }
  }

  const loadCourseFiles = useCallback(async (projectId: string) => {
    const res = await fetch(`/api/files?projectId=${projectId}`).catch(() => null);
    if (res?.ok) {
      const { files } = (await res.json()) as { files: UploadedFile[] };
      setCourseFiles((prev) => ({ ...prev, [projectId]: files }));
    }
  }, []);

  async function uploadCourseFiles(projectId: string, list: File[]) {
    for (const f of list.slice(0, 20)) {
      setCourseUploading((prev) => [...prev, f.name]);
      const out = await uploadFile(f, userId, projectId);
      setCourseUploading((prev) => prev.filter((n) => n !== f.name));
      if (!("id" in out)) alertLine(`${f.name}: ${out.error}`);
      else setCourseFiles((prev) => ({ ...prev, [projectId]: [out, ...(prev[projectId] ?? [])] }));
    }
  }

  // A chat attachment saved to the course: every chat in the course can use it, no re-upload needed.
  async function saveToCourse(messageId: string, ids: string[]) {
    const course = activeProject;
    if (!course) return;
    const ok = await Promise.all(
      ids.map((id) => fetch(`/api/files/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: course.id }) }).then((r) => r.ok).catch(() => false)),
    );
    const saved = ids.filter((_, i) => ok[i]);
    patchMessages(msgKey, (list) => list.map((x) => (x.id === messageId ? { ...x, attachments: x.attachments?.map((a) => (saved.includes(a.id) ? { ...a, project_id: course.id } : a)) } : x)));
    loadCourseFiles(course.id);
    alertLine(saved.length === ids.length ? `Saved to ${course.name}. Every chat in this course can use ${saved.length === 1 ? "it" : "them"}.` : "Couldn't save some files. Try again.");
  }

  async function deleteCourseFile(projectId: string, fileId: string) {
    const res = await fetch(`/api/files/${fileId}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) setCourseFiles((prev) => ({ ...prev, [projectId]: (prev[projectId] ?? []).filter((f) => f.id !== fileId) }));
  }

  const [notice, setNotice] = useState<string | null>(null);
  function alertLine(text: string) {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 6000);
  }

  // ---------------------------------------------------------------- sending
  async function send(text: string, retry = false) {
    const content = text.trim();
    const ready = pending.filter((p) => p.file);
    if ((!content && !retry && !ready.length) || busy || pending.some((p) => p.uploading)) return;
    const key = msgKey;
    const label = currentModel?.label ?? theme.appName;

    const attachmentIds = retry || imageMode ? [] : ready.map((p) => p.file!.id);
    if (!retry) {
      const attachments = imageMode ? [] : ready.map((p) => ({ id: p.file!.id, name: p.file!.name, kind: p.file!.kind, status: p.file!.status, error: p.file!.error }));
      patchMessages(key, (m) => [...m, { id: tmpId(), role: "user", kind: "text", content, status: "complete", attachments }]);
      setInput("");
      if (!imageMode) setPending([]);
    } else {
      // Drop the failed reply; the server does the same.
      patchMessages(key, (m) => {
        const last = m.map((x) => x.role).lastIndexOf("user");
        return m.slice(0, last + 1);
      });
    }

    if (imageMode && !retry) return sendImage(content, key);

    const replyTmp = tmpId();
    patchMessages(key, (m) => [...m, { id: replyTmp, role: "assistant", kind: "text", content: "", modelId, status: "streaming" }]);
    let currentKey = key;
    let convId = active?.id;
    const patchReply = (fn: (m: Message) => Message) => patchMessages(currentKey, (list) => list.map((x) => (x.id === replyTmp ? fn(x) : x)));

    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    // Folder tools only with the browser's permission. If it lapsed, this click lets the browser ask again.
    let link = FOLDER_ACCESS[provider] ? folder : null;
    if (link) {
      const ok = (await permission(link.handle, true).catch(() => "denied")) === "granted";
      setFolderOnline(ok);
      if (!ok) {
        link = null;
        alertLine("Folder access wasn't allowed, so this reply can't use your files. Allow it from the + menu.");
      }
    }

    const common = { provider, modelId, mode: chatSettings.mode, courseOnly: chatSettings.courseOnly, web: Boolean(chatSettings.web), folder: link ? { name: link.name } : undefined };
    let body: object = { ...common, content, retry, attachmentIds, conversationId: convId, projectId: active ? undefined : filter };
    const steps: Step[] = [];
    try {
      // One request per model round. When the model asks for file actions, run them here (after Apply for changes),
      // then send the results back to continue the same reply.
      for (;;) {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (handleAuth(res)) return;
        if (!res.ok || !res.body) {
          const err = (await res.json().catch(() => ({}))) as { error?: string; conversationId?: string };
          if (err.conversationId && !convId) {
            adoptConversation(err.conversationId, content.slice(0, 60), key);
            currentKey = convId = err.conversationId;
          }
          patchReply((m) => ({ ...m, status: "error", error: errorText(err.error ?? "unknown", label, theme.appName) }));
          return;
        }
        let toolTurn: { replyId: string; text: string; calls: ToolCall[] } | null = null;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            const ev = JSON.parse(line);
            if (ev.t === "meta") {
              if (!convId) {
                adoptConversation(ev.conversationId, ev.title, key);
                currentKey = convId = ev.conversationId;
              }
              setDropped((prev) => ({ ...prev, [ev.conversationId]: ev.dropped }));
              if (ev.summarized) setSettings((prev) => ({ ...prev, [ev.conversationId]: { ...(prev[ev.conversationId] ?? chatSettings), summarized: true } }));
            } else if (ev.t === "delta") patchReply((m) => ({ ...m, content: m.content + ev.v }));
            else if (ev.t === "done") {
              // Same shape as a reloaded message: [] = files were searched but none used, undefined = no files involved.
              patchReply((m) => ({
                ...m, status: ev.status === "partial" ? "partial" : "complete", sources: ev.grounding === "none" ? undefined : ev.sources,
                ...(typeof ev.content === "string" ? { content: ev.content } : {}), // the saved text (quiz lines removed)
              }));
              if (ev.quiz !== undefined) {
                const cid = convId ?? currentKey;
                setSettings((prev) => ({ ...prev, [cid]: { ...(prev[cid] ?? chatSettings), quiz: ev.quiz } }));
              }
            }
            else if (ev.t === "tool_calls") toolTurn = { replyId: ev.replyId, text: ev.text ?? "", calls: ev.calls ?? [] };
            else if (ev.t === "error") patchReply((m) => ({ ...m, status: "error", error: errorText(ev.code, label, theme.appName) }));
          }
        }
        if (!toolTurn) break;
        if (!link) {
          patchReply((m) => ({ ...m, status: "partial" }));
          break;
        }
        const results = await runToolCalls(link, toolTurn.calls, patchReply, controller.signal);
        if (controller.signal.aborted) {
          patchReply((m) => ({ ...m, status: "partial" }));
          break;
        }
        steps.push({ text: toolTurn.text, calls: toolTurn.calls, results });
        body = { ...common, conversationId: convId, run: { replyId: toolTurn.replyId, steps } };
      }
    } catch (e) {
      const stopped = (e as Error).name === "AbortError";
      patchReply((m) => ({ ...m, status: stopped ? "partial" : "error", error: stopped ? undefined : errorText("unknown", label, theme.appName) }));
    } finally {
      for (const decide of approvals.current.values()) decide(false);
      approvals.current.clear();
      setBusy(false);
      abortRef.current = null;
      loadUsage();
    }
  }

  // Run the model's file actions on the connected folder. Reads run straight away; changes are checked
  // first (dry run), then wait for the student's Apply / Skip.
  async function runToolCalls(link: FolderLink, calls: ToolCall[], patchReply: (fn: (m: Message) => Message) => void, signal: AbortSignal): Promise<StepResult[]> {
    const results: StepResult[] = [];
    for (const c of calls) {
      const actId = `${c.id}:${tmpId()}`;
      const setAct = (patch: Partial<Activity>) =>
        patchReply((m) => {
          const list = m.activity ?? [];
          const base: Activity = { id: actId, name: c.name, label: describeCall(c.name, c.args), status: "running" };
          return { ...m, activity: list.some((a) => a.id === actId) ? list.map((a) => (a.id === actId ? { ...a, ...patch } : a)) : [...list, { ...base, ...patch }] };
        });
      const fail = (error: string) => {
        setAct({ status: "error", detail: error, preview: undefined });
        results.push({ id: c.id, name: c.name, output: `Error: ${error}`, status: "error" });
        if (/didn't allow access/.test(error)) setFolderOnline(false);
      };
      if (signal.aborted) {
        results.push({ id: c.id, name: c.name, output: "Stopped by the student.", status: "declined" });
        continue;
      }
      if (!isFolderTool(c.name)) {
        fail(`Unknown tool ${c.name}.`);
        continue;
      }
      setAct({ status: "running" });
      if (isWriteTool(c.name)) {
        const check = await runFolderTool(link, c.name, c.args, true);
        if (!check.ok) {
          fail(check.error);
          continue;
        }
        // "Don't ask for edits" skips the prompt, except for deletes, which always ask.
        const autoApprove = approvalMode === "edits" && c.name !== "delete_path";
        if (!autoApprove) setAct({ status: "waiting", detail: check.output, preview: previewFor(c.name, c.args) });
        const approved = autoApprove || await new Promise<boolean>((resolve) => {
          approvals.current.set(actId, resolve);
          if (signal.aborted) resolve(false);
          signal.addEventListener("abort", () => resolve(false), { once: true });
        });
        approvals.current.delete(actId);
        if (!approved) {
          setAct({ status: "declined", preview: undefined, detail: undefined });
          results.push({ id: c.id, name: c.name, output: "The student declined this change. Don't try it again; ask what they'd like instead.", status: "declined" });
          continue;
        }
        setAct({ status: "running", preview: undefined, detail: undefined });
      }
      const out = await runFolderTool(link, c.name, c.args);
      if (out.ok) {
        setAct({ status: "ok" });
        results.push({ id: c.id, name: c.name, output: out.output, status: "ok" });
      } else fail(out.error);
    }
    return results;
  }

  function linkFolder(next: FolderLink) {
    saveFolder(next);
    setFolder(next);
    setFolderOnline(true);
    setFolderDialog(false);
    alertLine(`Connected to ${next.name}.`);
  }

  async function reconnectFolder() {
    if (!folder) return;
    const ok = (await permission(folder.handle, true).catch(() => "denied")) === "granted";
    setFolderOnline(ok);
    if (ok) setFolderDialog(false);
  }

  function unlinkFolder() {
    saveFolder(null);
    setFolder(null);
    setFolderOnline(false);
    setFolderDialog(false);
  }

  async function sendImage(prompt: string, key: string) {
    const replyTmp = tmpId();
    patchMessages(key, (m) => [...m, { id: replyTmp, role: "assistant", kind: "image", content: prompt, modelId: `${provider}-image`, status: "streaming" }]);
    let currentKey = key;
    setBusy(true);
    try {
      const res = await fetch("/api/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, prompt, conversationId: active?.id, projectId: active ? undefined : filter }),
      });
      if (handleAuth(res)) return;
      const out = (await res.json().catch(() => ({}))) as { conversationId?: string; title?: string; error?: string; message?: Message };
      if (out.conversationId && !active) {
        adoptConversation(out.conversationId, out.title ?? prompt.slice(0, 60), key);
        currentKey = out.conversationId;
      }
      patchMessages(currentKey, (list) =>
        list.map((x) =>
          x.id !== replyTmp ? x
            : out.message ? out.message
            : { ...x, status: "error", error: errorText(out.error ?? "unknown", imageModel?.label ?? "Image model", theme.appName) },
        ),
      );
    } finally {
      setBusy(false);
      loadUsage();
    }
  }

  // ---------------------------------------------------------------- UI pieces
  const sendButton = busy && !imageMode ? (
    <button type="button" onClick={() => abortRef.current?.abort()} aria-label="Stop"
      className={`grid shrink-0 place-items-center bg-brand text-on-brand transition hover:bg-brand-strong ${theme.sendClass}`}>
      <span className="h-3 w-3 rounded-[2px] bg-current" />
    </button>
  ) : (
    <button type="submit" disabled={(!input.trim() && !pending.some((p) => p.file)) || busy || pending.some((p) => p.uploading)} aria-label={imageMode ? "Create image" : "Send"}
      className={`grid shrink-0 place-items-center bg-brand text-on-brand transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-30 ${theme.sendClass}`}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );

  // Warn while there's still room to finish the session, in answers rather than dollars, and offer the cheapest model.
  const remainingNow = usage?.live ? usage.allowance - usage.spent - usage.reserved : Infinity;
  const cheapest = [...modelsFor(provider)].sort((a, b) => typicalAnswerMicros(a, usage?.typical) - typicalAnswerMicros(b, usage?.typical))[0];
  const perAnswer = currentModel ? typicalAnswerMicros(currentModel, usage?.typical) : 0;
  const cheapPerAnswer = cheapest ? typicalAnswerMicros(cheapest, usage?.typical) : 0;
  const offerCheaper = cheapest && cheapest.id !== modelId && remainingNow >= cheapPerAnswer;
  const lowBalance = usage?.live && currentModel && isLow(remainingNow, usage.allowance, perAnswer) && (
    <div role="status" className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface-200 px-4 py-2.5 text-sm">
      <span className="min-w-0 flex-1">
        {remainingNow < perAnswer
          ? `Not enough budget left for a ${currentModel.short} answer.`
          : `Running low: ${answersText(answersLeft(remainingNow, currentModel, usage.typical))} with ${currentModel.short}.`}{" "}
        {offerCheaper && (
          <span className="text-ink-muted">
            {cheapest.short} is {timesCheaper(perAnswer, cheapPerAnswer) > 1 ? `about ${timesCheaper(perAnswer, cheapPerAnswer)}× cheaper` : "cheaper"} ({answersText(answersLeft(remainingNow, cheapest, usage.typical))}).
          </span>
        )}
      </span>
      {offerCheaper && (
        <button type="button" onClick={() => setModel(cheapest.id)} className="rounded-full bg-brand px-3 py-1 text-xs font-medium text-on-brand">
          Switch to {cheapest.short}
        </button>
      )}
    </div>
  );

  // Quiz progress for this chat: score kept by the server, and the concepts to come back to.
  const quiz = chatSettings.mode === "quiz" ? chatSettings.quiz : null;
  const toReview = missedConcepts(quiz).slice(0, 6);
  const quizPanel = quiz && quiz.asked > 0 && (
    <div role="status" className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl border border-line bg-surface-200 px-4 py-2.5 text-sm">
      <span className="font-medium tabular-nums">Score {quiz.correct}/{quiz.asked}</span>
      <span className="min-w-0 flex-1 text-ink-muted">
        {toReview.length ? <>To review: {toReview.map((c) => (c.wrong > 1 ? `${c.concept} (missed ${c.wrong}×)` : c.concept)).join(", ")}</> : "Nothing to review yet — nice."}
      </span>
      {toReview.length > 0 && (
        <button type="button" disabled={busy} onClick={() => send(`Quiz me again on what I missed: ${toReview.map((c) => c.concept).join(", ")}.`)}
          className="rounded-full bg-brand px-3 py-1 text-xs font-medium text-on-brand disabled:opacity-50">
          Practise what I missed
        </button>
      )}
    </div>
  );

  const placeholder = imageMode ? "Describe an image" : empty ? `Ask ${theme.appName}` : `Reply to ${theme.appName}…`;
  const textarea = (
    <textarea
      value={input}
      onChange={(e) => setInput(e.target.value)}
      onInput={(e) => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          send(input);
        }
      }}
      rows={theme.inlineComposer ? 1 : empty ? 2 : 1}
      aria-label="Message"
      placeholder={placeholder}
      className="max-h-40 w-full min-w-0 flex-1 resize-none bg-transparent py-1.5 text-base text-ink outline-none placeholder:text-ink-subtle"
    />
  );
  const tools = (
    <ToolsMenu
      onUpload={() => fileInput.current?.click()}
      imageLabel={imageModel?.label ?? null} imageMode={imageMode} onImageMode={setImageMode}
      mode={chatSettings.mode} onMode={(m) => setChatSettings({ mode: m })}
      courseOnly={chatSettings.courseOnly} onCourseOnly={(v) => setChatSettings({ courseOnly: v, ...(v ? { web: false } : {}) })}
      web={Boolean(chatSettings.web)} onWeb={(v) => setChatSettings({ web: v, ...(v ? { courseOnly: false } : {}) })}
      folderName={folder?.name ?? null} folderOffline={Boolean(folder) && !folderOnline}
      onFolder={FOLDER_ACCESS[provider] ? () => setFolderDialog(true) : undefined}
      disabled={busy}
    />
  );
  const pendingChips = pending.length > 0 && (
    <div className="mb-2 flex flex-wrap gap-2">
      {pending.map((p) => (
        <FileChip key={p.key} name={p.name} kind={p.file?.kind} state={p.uploading ? "uploading" : p.error ? "failed" : p.file!.status}
          detail={p.error ?? (p.file ? fileNote(p.file) : undefined)}
          onRemove={() => setPending((prev) => prev.filter((x) => x.key !== p.key))} />
      ))}
    </div>
  );
  const modelMenu = imageMode ? null : <ModelMenu provider={provider} value={modelId} onChange={setModel} disabled={busy} />;

  const composer = (
    <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="w-full"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) attachFiles(Array.from(e.dataTransfer.files)); }}
      onPaste={(e) => { const imgs = Array.from(e.clipboardData.files); if (imgs.length) { e.preventDefault(); attachFiles(imgs); } }}>
      <input ref={fileInput} type="file" multiple accept={ACCEPT_ATTR} hidden onChange={(e) => { attachFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      {lowBalance}
      {quizPanel}
      {theme.inlineComposer ? (
        <div className={`mx-auto max-w-3xl py-2.5 pl-3 pr-3 transition ${theme.composerClass}`}>
          {pendingChips && <div className="px-2 pt-1">{pendingChips}</div>}
          <div className="flex items-center gap-1.5">
            {tools}
            {textarea}
            {modelMenu}
            {sendButton}
          </div>
        </div>
      ) : (
        <div className={`mx-auto max-w-3xl p-2.5 pl-4 transition ${theme.composerClass}`}>
          {pendingChips}
          {textarea}
          <div className="mt-1 flex items-center gap-1.5">
            {tools}
            <span className="flex-1" />
            {modelMenu}
            {sendButton}
          </div>
        </div>
      )}
    </form>
  );

  const remaining = usage?.live ? usage.allowance - usage.spent - usage.reserved : 0;
  const usedPct = usage?.live && usage.allowance > 0 ? Math.min(100, ((usage.spent + usage.reserved) / usage.allowance) * 100) : 0;

  return (
    <div data-theme={provider} className="flex h-dvh bg-surface-000 font-ui text-ink">
      {/* App rail */}
      <nav aria-label="AI apps" className="hidden w-[76px] shrink-0 flex-col items-center gap-3 border-r border-line bg-surface-100 py-4 md:flex">
        <Image src="/brand/orbit-mark.png" alt="Orbit AI" width={32} height={32} className="logo-mono mb-3 h-8 w-8 object-contain" />
        {PROVIDERS.map((p) => {
          const on = p === provider;
          return (
            <button key={p} onClick={() => pickProvider(p)} disabled={busy && !on} aria-pressed={on} title={THEMES[p].appName}
              className="group flex flex-col items-center gap-1 disabled:cursor-not-allowed disabled:opacity-50">
              <span className={`grid h-11 w-11 place-items-center rounded-2xl border transition ${on ? "border-line-strong bg-surface-300 shadow-composer" : "border-transparent group-hover:bg-surface-200"}`}>
                <ProviderLogo provider={p} size={24} />
              </span>
              <span className={`text-[11px] ${on ? "font-semibold text-ink" : "text-ink-subtle group-hover:text-ink-muted"}`}>{THEMES[p].appName}</span>
            </button>
          );
        })}
      </nav>

      {/* This app's projects + chats */}
      <aside className={`fixed inset-y-0 left-0 z-30 flex w-72 flex-col bg-surface-100 transition-transform md:static md:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex items-center gap-2.5 px-5 pb-3 pt-5">
          <ProviderLogo provider={provider} size={22} />
          <span className="text-[22px] font-normal tracking-tight">{theme.appName}</span>
          <button onClick={() => setSidebarOpen(false)} className="ml-auto rounded-md p-1 text-ink-muted hover:text-ink md:hidden" aria-label="Close menu">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="px-3">
          <button onClick={newChat} className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-[15px] transition hover:bg-surface-200 ${theme.itemClass}`}>
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
              <path d="M11.5 4.5H5.5a1.5 1.5 0 0 0-1.5 1.5v8.5A1.5 1.5 0 0 0 5.5 16H14a1.5 1.5 0 0 0 1.5-1.5v-6M13.6 3.4a1.4 1.4 0 0 1 2 2L10 11l-2.6.6.6-2.6 5.6-5.6z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            New chat
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          {/* Projects */}
          <div className="mt-5 flex items-center justify-between px-3">
            <p className="text-sm text-ink-subtle">Courses</p>
            <button onClick={() => setProjectDialog({})} aria-label="New course" className="grid h-6 w-6 place-items-center rounded-full text-ink-subtle hover:bg-surface-200 hover:text-ink">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </button>
          </div>
          <div className="mt-1 space-y-0.5">
            {projects[provider].length === 0 && (
              <button onClick={() => setProjectDialog({})} className={`w-full px-3 py-2 text-left text-sm text-ink-subtle hover:bg-surface-200 ${theme.itemClass}`}>
                + Add a course
              </button>
            )}
            {projects[provider].map((p) => {
              const on = filter === p.id;
              return (
                <div key={p.id} className={`group flex items-center ${theme.itemClass} ${on ? "bg-surface-300 font-medium" : "hover:bg-surface-200"}`}>
                  <button
                    onClick={() => selectCourse(on ? null : p.id)}
                    aria-pressed={on}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left text-[15px]">
                    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden className="shrink-0 text-ink-muted">
                      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" fill="none" stroke="currentColor" strokeWidth="1.3" />
                    </svg>
                    <span className="truncate">{p.name}</span>
                  </button>
                  <button onClick={() => openCourse(p)} aria-label={`${p.name} settings and files`} title="Course settings and files"
                    className="py-1 pl-1.5 pr-3 text-ink-subtle transition hover:text-ink focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100">
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden><circle cx="3.5" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="12.5" cy="8" r="1.2" fill="currentColor" /></svg>
                  </button>
                </div>
              );
            })}
          </div>

          {/* Chats */}
          <p className="mt-5 px-3 text-sm text-ink-subtle">{filter ? "Chats in this course" : "Recents"}</p>
          <nav className="mt-1 space-y-0.5" aria-label={`${theme.appName} chats`}>
            {appConvs === null && <p className="px-3 py-2 text-sm text-ink-subtle">Loading…</p>}
            {appConvs !== null && visibleConvs.length === 0 && <p className="px-3 py-2 text-sm text-ink-subtle">No chats yet.</p>}
            {visibleConvs.map((c) => (
              <div key={c.id} className={`group flex items-center ${theme.itemClass} ${c.id === activeId ? "bg-surface-300 font-medium" : "hover:bg-surface-200"}`}>
                {renaming === c.id ? (
                  <input autoFocus defaultValue={c.title} aria-label="Chat name"
                    onBlur={(e) => renameChat(c.id, e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRenaming(null); }}
                    className="min-w-0 flex-1 rounded-lg bg-surface-000 px-3 py-2 text-[15px] outline-none ring-1 ring-brand" />
                ) : (
                  <button onClick={() => { setActive(c.id); setSidebarOpen(false); }} onDoubleClick={() => setRenaming(c.id)}
                    aria-current={c.id === activeId ? "page" : undefined} className="min-w-0 flex-1 truncate px-3 py-2.5 text-left text-[15px]">
                    {c.title || "Untitled"}
                  </button>
                )}
                <button onClick={() => setRenaming(c.id)} aria-label={`Rename ${c.title || "chat"}`}
                  className="px-1.5 py-1 text-ink-subtle transition hover:text-ink focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100">
                  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M10.5 2.5l3 3L6 13H3v-3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
                </button>
                <button onClick={() => deleteChat(c.id)} aria-label={`Delete ${c.title || "chat"}`}
                  className="py-1 pl-1.5 pr-3 text-ink-subtle transition hover:text-danger focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100">
                  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden><path d="M3 4h10M6.5 4V2.5h3V4M5 4l.6 9h4.8L11 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            ))}
          </nav>
        </div>

        {/* Usage */}
        <div className="m-3 rounded-2xl bg-surface-200 p-4 text-sm">
          <div className="mb-1.5 flex justify-between">
            <span className="font-medium">{usage?.live ? "Budget" : "Demo mode"}</span>
            <span className="tabular-nums text-ink-muted">
              {usage?.live ? `${dollars(remaining)} left of ${dollars(usage.allowance)}` : "Replies are fake"}
            </span>
          </div>
          {usage?.live && currentModel && (
            <p className="mb-1.5 text-xs text-ink-muted">
              {answersText(answersLeft(remaining, currentModel, usage.typical)).replace(/^about/, "About")} with {currentModel.short}
              {usage.reserved > 0 && " · a reply is in progress"}
            </p>
          )}
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-300" role="meter" aria-label="Budget used"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usedPct)}>
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${usedPct}%` }} />
          </div>
          {usage?.live && (
            <details className="mt-2 text-xs text-ink-muted">
              <summary className="cursor-pointer select-none text-ink-subtle hover:text-ink-muted">How your budget works</summary>
              <ul className="mt-1.5 list-disc space-y-1 pl-4">
                <li>Each answer costs a little, based on how long the chat, files and answer are. Bigger models cost more per answer.</li>
                <li>Before an answer starts, its most it could cost is set aside, so you can never go over. Afterwards you only pay what it really cost; the rest comes back.</li>
                <li>Long chats and big files cost more per answer. Starting a new chat, or a cheaper model, makes your budget last longer.</li>
                <li>If an answer fails before it starts, you aren&apos;t charged.</li>
              </ul>
            </details>
          )}
          <p className="mt-3 truncate text-xs text-ink-subtle">{email}</p>
          <form action={signOut}>
            <button className="mt-0.5 text-xs text-ink-subtle underline underline-offset-[3px] hover:text-ink-muted">Sign out</button>
          </form>
        </div>
      </aside>
      {sidebarOpen && <div className="fixed inset-0 z-20 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 items-center gap-2 px-4 py-2.5">
          <button onClick={() => setSidebarOpen(true)} className="rounded-md p-1 text-ink-muted hover:text-ink md:hidden" aria-label="Open menu">
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
          {activeProject && (
            <button onClick={() => openCourse(activeProject)} title="Course settings and files"
              className="flex min-w-0 items-center gap-2 rounded-full px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-200 hover:text-ink">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden className="shrink-0"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
              <span className="truncate">{activeProject.name}</span>
            </button>
          )}
          {active && projects[provider].length > 0 && (
            <label className="ml-auto hidden items-center gap-1.5 text-xs text-ink-subtle sm:flex">
              Course
              <select value={active.projectId ?? ""} onChange={(e) => moveToProject(active.id, e.target.value || null)}
                className="rounded-full border border-line bg-surface-100 px-2.5 py-1 text-xs text-ink outline-none">
                <option value="">None</option>
                {projects[provider].map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
          <div className={`flex gap-1 md:hidden ${active && projects[provider].length > 0 ? "" : "ml-auto"}`} role="group" aria-label="AI apps">
            {PROVIDERS.map((p) => (
              <button key={p} onClick={() => pickProvider(p)} disabled={busy && p !== provider} aria-pressed={p === provider} aria-label={THEMES[p].appName}
                className={`grid h-9 w-9 place-items-center rounded-xl ${p === provider ? "bg-surface-300" : ""}`}>
                <ProviderLogo provider={p} size={20} />
              </button>
            ))}
          </div>
        </header>

        {empty ? (
          <div className="flex flex-1 flex-col items-center justify-center px-4 pb-[12vh]">
            {activeProject && (
              <div className="mb-6 w-full max-w-3xl rounded-2xl border border-line bg-surface-100 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden className="shrink-0 text-ink-muted"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
                  <span className="font-medium">{activeProject.name}</span>
                  <span className="text-xs text-ink-subtle">
                    {courseFiles[activeProject.id] ? `${courseFiles[activeProject.id].length} course file${courseFiles[activeProject.id].length === 1 ? "" : "s"}` : "Loading files…"}
                    {activeProject.instructions.trim() ? " · has instructions" : ""}
                  </span>
                  <button onClick={() => openCourse(activeProject)} className="ml-auto rounded-full border border-line-strong px-3 py-1 text-xs font-medium hover:bg-surface-300">
                    {courseFiles[activeProject.id]?.length ? "Manage files" : "Add course files"}
                  </button>
                </div>
                {courseFiles[activeProject.id]?.length ? (
                  <p className="mt-1.5 truncate text-xs text-ink-subtle">Answers can cite: {courseFiles[activeProject.id].map((f) => f.name).join(", ")}</p>
                ) : (
                  <p className="mt-1.5 text-xs text-ink-subtle">Add lecture slides, readings or assignment specs and every chat in this course can quote them by page.</p>
                )}
              </div>
            )}
            <h1 className={`mb-8 text-center ${theme.greetingClass}`}>{imageMode ? "What should I create?" : chatSettings.mode === "quiz" ? "What should I quiz you on?" : chatSettings.mode === "hints" ? "What are you working on?" : chatSettings.mode === "explain" ? "What should I explain?" : theme.greeting}</h1>
            {composer}
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl px-4 py-6">
                {active && (dropped[active.id] || chatSettings.summarized) && (
                  <p className="mb-6 rounded-xl bg-surface-200 px-4 py-2.5 text-center text-xs text-ink-muted">
                    {chatSettings.summarized
                      ? `This chat is long: ${currentModel?.label ?? "the model"} gets a summary of older messages plus the recent ones.`
                      : `Older messages not included — this chat is longer than ${currentModel?.label ?? "the model"} is sent at once.`}
                  </p>
                )}
                <ul className="space-y-8">
                  {thread.map((m, idx) => {
                    const model = getModel(m.modelId);
                    // Mark where the chat moved to another model, so it's clear who wrote what.
                    const prevReply = thread.slice(0, idx).reverse().find((x) => x.role === "assistant" && x.kind === "text" && x.modelId);
                    const switched = m.role === "assistant" && m.kind === "text" && model && prevReply?.modelId && prevReply.modelId !== m.modelId;
                    if (m.role === "user") {
                      return (
                        <li key={m.id} className="flex flex-col items-end gap-2">
                          {m.attachments && m.attachments.length > 0 && (
                            <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
                              {m.attachments.map((a) => <FileChip key={a.id} name={a.name} kind={a.kind} state={a.status} detail={a.error ?? undefined} />)}
                            </div>
                          )}
                          {activeProject && (() => {
                            const unsaved = (m.attachments ?? []).filter((a) => a.status !== "failed" && a.project_id !== activeProject.id);
                            return unsaved.length > 0 && (
                              <button type="button" onClick={() => saveToCourse(m.id, unsaved.map((a) => a.id))}
                                className="text-xs font-medium text-ink-muted underline-offset-[3px] hover:text-ink hover:underline">
                                Save {unsaved.length === 1 ? "file" : `${unsaved.length} files`} to {activeProject.name}
                              </button>
                            );
                          })()}
                          {m.content && <div className={`max-w-[80%] whitespace-pre-wrap leading-relaxed ${theme.userBubbleClass}`}>{m.content}</div>}
                        </li>
                      );
                    }
                    return (
                      <li key={m.id}>
                        {switched && (
                          <div role="separator" className="mb-4 flex items-center gap-3 text-xs text-ink-subtle">
                            <span className="h-px flex-1 bg-line" />
                            Switched to {model.label} · it has the chat so far
                            <span className="h-px flex-1 bg-line" />
                          </div>
                        )}
                        <div className="mb-1.5 text-xs font-medium text-ink-subtle">
                          {m.kind === "image" || m.modelId?.endsWith("-image") ? (imageModel?.label ?? "Image") : model?.label}
                        </div>
                        {m.kind === "image" ? (
                          m.status === "streaming" ? (
                            <div className="grid aspect-square w-full max-w-sm animate-pulse place-items-center rounded-2xl bg-surface-200 text-sm text-ink-subtle">Creating image…</div>
                          ) : m.imageUrl ? (
                            <a href={m.imageUrl} target="_blank" rel="noreferrer" className="block w-full max-w-sm">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={m.imageUrl} alt={m.content} className="w-full rounded-2xl border border-line" />
                            </a>
                          ) : m.status === "error" ? null : (
                            <p className="text-sm text-ink-subtle">Image unavailable.</p>
                          )
                        ) : (
                          <div className={`whitespace-pre-wrap ${theme.replyClass}`}>
                            <AnswerText text={m.content} sources={m.sources} final={m.status !== "streaming"} />
                            {m.status === "streaming" && <span aria-label="Writing" className="orbit-caret ml-0.5 inline-block h-4 w-1.5 rounded-sm bg-ice align-middle" />}
                            {m.status === "partial" && <span className="ml-1 text-xs text-ink-subtle">[stopped]</span>}
                          </div>
                        )}
                        {m.activity && m.activity.length > 0 && (
                          <FolderActivity items={m.activity} onDecide={(id, ok) => approvals.current.get(id)?.(ok)} />
                        )}
                        {m.kind === "text" && m.sources && m.sources.length > 0 && (
                          <SourceList sources={m.sources} />
                        )}
                        {m.kind === "text" && m.status === "complete" && /couldn.t find this in your course files/i.test(m.content) ? (
                          <p className="mt-3 inline-flex rounded-full bg-surface-200 px-3 py-1 text-xs font-medium text-warning">Not found in your course files</p>
                        ) : m.kind === "text" && m.status === "complete" && m.sources && m.sources.length === 0 ? (
                          <p className="mt-3 text-xs text-ink-subtle">Not from your files: this answer didn&apos;t use any passage from them.</p>
                        ) : null}
                        {m.status === "error" && (
                          <div className="mt-2 rounded-xl border border-danger/30 bg-danger-surface p-3 text-sm text-danger">
                            {m.error ?? `${model?.label ?? "The model"} didn't respond. Your chat is saved.`}{" "}
                            {m.kind === "text" && m.error?.includes("budget left") && offerCheaper && (
                              <button onClick={() => setModel(cheapest.id)} disabled={busy} className="mr-3 font-medium underline underline-offset-[3px]">
                                Switch to {cheapest.short}
                              </button>
                            )}
                            {m.kind === "text" && <button onClick={() => send("", true)} disabled={busy} className="font-medium underline underline-offset-[3px]">Try again</button>}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div ref={bottomRef} />
              </div>
            </div>
            <div className="px-3 pb-1">{composer}</div>
          </>
        )}
        <p className="px-4 pb-3 pt-2 text-center text-xs text-ink-muted">
          {theme.disclaimer}
          {usage && !usage.liveProviders?.includes(provider) && <span className="text-ink-subtle"> Demo mode: {theme.appName} replies are fake until its API key is added.</span>}
        </p>
      </main>

      <FolderDialog
        open={folderDialog}
        link={folder}
        needsPermission={Boolean(folder) && !folderOnline}
        onClose={() => setFolderDialog(false)}
        onLinked={linkFolder}
        onReconnect={reconnectFolder}
        onDisconnect={unlinkFolder}
        approvalMode={approvalMode}
        onApprovalMode={(m) => {
          setApprovalMode(m);
          saveApprovalMode(m);
        }}
      />
      <ProjectDialog
        open={projectDialog !== null}
        initial={projectDialog?.editing}
        files={projectDialog?.editing ? courseFiles[projectDialog.editing.id] : undefined}
        uploading={courseUploading}
        onClose={() => setProjectDialog(null)}
        onSave={saveProject}
        onDelete={projectDialog?.editing ? () => deleteProject(projectDialog.editing!.id) : undefined}
        onUpload={projectDialog?.editing ? (list) => uploadCourseFiles(projectDialog.editing!.id, list) : undefined}
        onDeleteFile={projectDialog?.editing ? (fid) => deleteCourseFile(projectDialog.editing!.id, fid) : undefined}
      />
      {notice && (
        <div role="status" className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-sm text-surface-000 shadow-menu">{notice}</div>
      )}
    </div>
  );
}
