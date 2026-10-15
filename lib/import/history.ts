// Import AI conversation history (Jake's integration memo, section 4): students keep their past ChatGPT/Claude chats
// when they switch to Orbit. Parses the official export files in the browser; the server only receives the text.
//  - ChatGPT: Settings → Data controls → Export data → emailed .zip with conversations.json (a tree per chat;
//    we follow the branch that was last shown).
//  - Claude: Settings → Privacy → Export data → .zip with conversations.json (a list of messages per chat).

export type ImportSource = "chatgpt" | "claude";
export type ImportedMessage = { role: "user" | "assistant"; content: string; at: string | null };
export type ImportedChat = { key: string; title: string; createdAt: string | null; updatedAt: string | null; messages: ImportedMessage[] };
export type ParsedExport = { source: ImportSource; chats: ImportedChat[]; skipped: number };

export const IMPORT_LIMITS = { chats: 1000, messagesPerChat: 2000, messageChars: 32_000, chatChars: 1_200_000, titleChars: 120 };

const iso = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Join consecutive messages from the same side and trim sizes. */
function tidy(messages: ImportedMessage[]): ImportedMessage[] {
  const out: ImportedMessage[] = [];
  for (const m of messages) {
    const content = m.content.replace(/\u0000/g, "").trim();
    if (!content) continue;
    const last = out.at(-1);
    if (last && last.role === m.role) last.content = `${last.content}\n\n${content}`.slice(0, IMPORT_LIMITS.messageChars);
    else out.push({ ...m, content: content.slice(0, IMPORT_LIMITS.messageChars) });
  }
  // Very long chats keep their most recent part (fits one upload request).
  let kept = out.slice(-IMPORT_LIMITS.messagesPerChat);
  let total = kept.reduce((n, m) => n + m.content.length, 0);
  while (kept.length > 1 && total > IMPORT_LIMITS.chatChars) {
    total -= kept[0].content.length;
    kept = kept.slice(1);
  }
  return kept;
}

function chatgptText(content: unknown): string {
  const c = obj(content);
  if (!c) return "";
  if (Array.isArray(c.parts)) return c.parts.filter((p): p is string => typeof p === "string").join("\n");
  if (typeof c.text === "string") return c.text;
  return "";
}

function parseChatGPT(list: unknown[]): ParsedExport {
  const chats: ImportedChat[] = [];
  let skipped = 0;
  for (const raw of list) {
    const c = obj(raw);
    const mapping = obj(c?.mapping);
    if (!c || !mapping) { skipped++; continue; }
    // Walk from the last shown message back to the start: that's the conversation as the student last saw it.
    let nodeId = typeof c.current_node === "string" ? c.current_node : Object.keys(mapping).at(-1);
    const branch: ImportedMessage[] = [];
    const seen = new Set<string>();
    while (nodeId && !seen.has(nodeId)) {
      seen.add(nodeId);
      const node = obj(mapping[nodeId]);
      const msg = obj(node?.message);
      const role = obj(msg?.author)?.role;
      const hidden = obj(msg?.metadata)?.is_visually_hidden_from_conversation === true;
      const type = obj(msg?.content)?.content_type;
      if (msg && !hidden && (role === "user" || role === "assistant") && (type === "text" || type === "multimodal_text" || type === undefined)) {
        branch.push({ role, content: chatgptText(msg.content), at: iso(msg.create_time) });
      }
      nodeId = typeof node?.parent === "string" ? node.parent : undefined;
    }
    const messages = tidy(branch.reverse());
    if (!messages.length) { skipped++; continue; }
    const id = typeof c.conversation_id === "string" ? c.conversation_id : typeof c.id === "string" ? c.id : `${c.title}-${c.create_time}`;
    chats.push({
      key: `chatgpt:${id}`.slice(0, 200), title: String(c.title || messages[0].content).slice(0, IMPORT_LIMITS.titleChars) || "Imported chat",
      createdAt: iso(c.create_time), updatedAt: iso(c.update_time) ?? iso(c.create_time), messages,
    });
  }
  return { source: "chatgpt", chats, skipped };
}

function parseClaude(list: unknown[]): ParsedExport {
  const chats: ImportedChat[] = [];
  let skipped = 0;
  for (const raw of list) {
    const c = obj(raw);
    if (!c || !Array.isArray(c.chat_messages)) { skipped++; continue; }
    const messages = tidy(c.chat_messages.map((m) => {
      const mm = obj(m) ?? {};
      const parts = Array.isArray(mm.content) ? mm.content.map((p) => (obj(p)?.type === "text" ? String(obj(p)?.text ?? "") : "")).filter(Boolean).join("\n") : "";
      return { role: mm.sender === "human" ? "user" as const : "assistant" as const, content: typeof mm.text === "string" && mm.text ? mm.text : parts, at: iso(mm.created_at) };
    }));
    if (!messages.length) { skipped++; continue; }
    chats.push({
      key: `claude:${String(c.uuid ?? `${c.name}-${c.created_at}`)}`.slice(0, 200), title: String(c.name || messages[0].content).slice(0, IMPORT_LIMITS.titleChars) || "Imported chat",
      createdAt: iso(c.created_at), updatedAt: iso(c.updated_at) ?? iso(c.created_at), messages,
    });
  }
  return { source: "claude", chats, skipped };
}

/** conversations.json from either export → chats, newest first. Throws a friendly Error if it isn't one. */
export function parseExport(json: unknown): ParsedExport {
  const list = Array.isArray(json) ? json : null;
  if (!list) throw new Error("That file isn't a ChatGPT or Claude export (expected conversations.json).");
  const first = list.map(obj).find(Boolean);
  const parsed = first && "mapping" in first ? parseChatGPT(list) : first && "chat_messages" in first ? parseClaude(list) : null;
  if (!parsed) throw new Error(list.length ? "That file isn't a ChatGPT or Claude export (expected conversations.json)." : "That export has no conversations.");
  parsed.chats.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  if (parsed.chats.length > IMPORT_LIMITS.chats) {
    parsed.skipped += parsed.chats.length - IMPORT_LIMITS.chats;
    parsed.chats = parsed.chats.slice(0, IMPORT_LIMITS.chats);
  }
  return parsed;
}

/** Read the export the student chose: the .zip as downloaded, or conversations.json taken out of it. Browser only. */
export async function readExportFile(file: File): Promise<ParsedExport> {
  let text: string;
  if (/\.zip$/i.test(file.name) || file.type.includes("zip")) {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(file);
    const entry = zip.file(/(^|\/)conversations\.json$/i)[0];
    if (!entry) throw new Error("No conversations.json in that .zip. Is it the export from ChatGPT or Claude?");
    text = await entry.async("string");
  } else text = await file.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Couldn't read that file. Choose the .zip from the export email, or conversations.json inside it.");
  }
  return parseExport(json);
}

/** Split chats into request-sized batches (the server accepts ~4 MB per request). */
export function importBatches(chats: ImportedChat[], maxBytes = 1_500_000, maxChats = 25): ImportedChat[][] {
  const out: ImportedChat[][] = [];
  let cur: ImportedChat[] = [];
  let size = 0;
  for (const c of chats) {
    const n = JSON.stringify(c).length;
    if (cur.length && (size + n > maxBytes || cur.length >= maxChats)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(c);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- server-side checks
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const when = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/** Server side: validate chats sent by the browser (never trust the client's parsing). */
export function cleanChats(input: unknown): ImportedChat[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 50) return null;
  const chats: ImportedChat[] = [];
  for (const raw of input) {
    const c = raw as Partial<ImportedChat>;
    const key = str(c?.key, 200);
    if (!/^(chatgpt|claude):/.test(key) || !Array.isArray(c.messages)) return null;
    const messages = c.messages.slice(-IMPORT_LIMITS.messagesPerChat)
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content.slice(0, IMPORT_LIMITS.messageChars), at: when(m.at) }));
    if (!messages.length) continue;
    chats.push({ key, title: str(c.title, IMPORT_LIMITS.titleChars).trim() || "Imported chat", createdAt: when(c.createdAt), updatedAt: when(c.updatedAt), messages });
  }
  return chats;
}

