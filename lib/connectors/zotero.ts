// Zotero connector (integration memo #10): read-only. The student makes a read-only API key at
// zotero.org/settings/keys and pastes it once; it stays in this browser. Search the library, tick items, and Orbit
// brings in each item's citation, abstract and notes (plus BibTeX), so answers can cite the student's own sources.
// Zotero's Web API allows browser calls, so no server relay is needed.
import { htmlToText } from "./mail-calendar";
import { ConnectorError } from "./types";

const API = "https://api.zotero.org";
const KEY = "orbit.zotero";
export const ZOTERO_LIMITS = { search: 30, pick: 15, noteChars: 6_000 };

export type ZoteroCreator = { creatorType?: string; firstName?: string; lastName?: string; name?: string };
export type ZoteroItem = {
  key: string; itemType: string; title: string; creators: ZoteroCreator[]; date: string; publicationTitle?: string;
  DOI?: string; url?: string; abstractNote?: string; volume?: string; issue?: string; pages?: string; publisher?: string;
};
export type ZoteroAuth = { key: string; userId: number; username: string };

export function zoteroAuth(): ZoteroAuth | null {
  try {
    const v = localStorage.getItem(KEY);
    return v ? (JSON.parse(v) as ZoteroAuth) : null;
  } catch {
    return null;
  }
}
export function setZoteroAuth(v: ZoteroAuth | null) {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {}
}

const year = (d: string) => d.match(/\b(1[5-9]|20)\d{2}\b/)?.[0] ?? "n.d.";
const person = (c: ZoteroCreator) => c.name ?? [c.lastName, c.firstName ? c.firstName.split(/[\s-]+/).filter(Boolean).map((p) => `${p[0]}.`).join(" ") : ""].filter(Boolean).join(", ");

/** APA-style reference line (good enough for study notes; the BibTeX is exact). Pure. */
export function apaCitation(it: ZoteroItem): string {
  const authors = it.creators.filter((c) => !c.creatorType || c.creatorType === "author").map(person).filter(Boolean);
  const who = authors.length === 0 ? "" : authors.length === 1 ? authors[0] : authors.length <= 20 ? `${authors.slice(0, -1).join(", ")}, & ${authors.at(-1)}` : `${authors.slice(0, 19).join(", ")}, … ${authors.at(-1)}`;
  const src = [it.publicationTitle ? `*${it.publicationTitle}*` : it.publisher ?? "", it.volume ? `${it.volume}${it.issue ? `(${it.issue})` : ""}` : "", it.pages ?? ""].filter(Boolean).join(", ");
  const link = it.DOI ? `https://doi.org/${it.DOI.replace(/^https?:\/\/doi\.org\//, "")}` : it.url ?? "";
  return [who ? `${who} (${year(it.date)}).` : `${it.title}. (${year(it.date)}).`, who ? `${it.title}.` : "", src ? `${src}.` : "", link].filter(Boolean).join(" ");
}

/** One Markdown file for the picked items. Pure. */
export function bundleZotero(items: { item: ZoteroItem; notes: string[] }[], bibtex: string): string {
  const head = `# Zotero: ${items.length} source${items.length === 1 ? "" : "s"}\n\nImported into Orbit on ${new Date().toISOString().slice(0, 10)} (read-only copy). Cite these sources by their reference.`;
  const parts = items.map(({ item, notes }) => [
    `## ${item.title || "Untitled"}`,
    `**Reference (APA):** ${apaCitation(item)}`,
    item.abstractNote ? `**Abstract:** ${item.abstractNote.trim()}` : "",
    ...notes.map((n, i) => `**Note${notes.length > 1 ? ` ${i + 1}` : ""}:**\n\n${n.length > ZOTERO_LIMITS.noteChars ? `${n.slice(0, ZOTERO_LIMITS.noteChars)}…` : n}`),
  ].filter(Boolean).join("\n\n"));
  return [head, ...parts, bibtex.trim() ? `## BibTeX\n\n\`\`\`bibtex\n${bibtex.trim()}\n\`\`\`` : ""].filter(Boolean).join("\n\n") + "\n";
}

async function zget(path: string, key: string): Promise<Response> {
  const res = await fetch(`${API}${path}`, { headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3" } }).catch(() => null);
  if (!res) throw new ConnectorError("Couldn't reach Zotero. Try again.");
  if (res.status === 403) throw new ConnectorError("Zotero didn't accept that key. Make a new read-only key and paste it again.");
  if (res.status === 429) throw new ConnectorError("Zotero is busy. Try again in a minute.");
  if (!res.ok) throw new ConnectorError("Couldn't reach Zotero. Try again.");
  return res;
}

/** Checks a pasted key and finds whose library it opens. */
export async function connectZotero(rawKey: string): Promise<ZoteroAuth> {
  const key = rawKey.trim();
  if (!/^[A-Za-z0-9]{24}$/.test(key)) throw new ConnectorError("A Zotero key is 24 letters and numbers.");
  const j = (await (await zget(`/keys/${key}`, key)).json()) as { userID: number; username: string; access?: { user?: { library?: boolean } } };
  if (!j.access?.user?.library) throw new ConnectorError("That key can't read your library. Tick \"Allow library access\" when you make it.");
  const auth = { key, userId: j.userID, username: j.username };
  setZoteroAuth(auth);
  return auth;
}

type Raw = { key: string; data: ZoteroItem & { parentItem?: string; note?: string } };
export async function searchZotero(auth: ZoteroAuth, q: string): Promise<ZoteroItem[]> {
  const res = await zget(`/users/${auth.userId}/items/top?limit=${ZOTERO_LIMITS.search}&sort=dateModified&format=json&itemType=-attachment${q.trim() ? `&q=${encodeURIComponent(q.trim())}&qmode=titleCreatorYear` : ""}`, auth.key);
  return ((await res.json()) as Raw[]).map((r) => ({ ...r.data, key: r.key, creators: r.data.creators ?? [] }));
}

/** The picked items' notes and BibTeX. */
export async function readZotero(auth: ZoteroAuth, items: ZoteroItem[]): Promise<string> {
  const keys = items.map((i) => i.key).join(",");
  const [bib, ...kids] = await Promise.all([
    zget(`/users/${auth.userId}/items?itemKey=${keys}&format=bibtex`, auth.key).then((r) => r.text()).catch(() => ""),
    ...items.map((i) => zget(`/users/${auth.userId}/items/${i.key}/children?itemType=note&format=json`, auth.key).then((r) => r.json() as Promise<Raw[]>).catch(() => [] as Raw[])),
  ]);
  return bundleZotero(items.map((item, i) => ({ item, notes: (kids[i] as Raw[]).map((n) => htmlToText(n.data.note ?? "").trim()).filter(Boolean) })), bib as string);
}
