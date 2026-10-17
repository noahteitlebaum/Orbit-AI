// Email and calendar connectors (integration memo #5–6): read-only. The student searches their inbox and ticks the
// emails to bring in, or brings in their next two weeks of events; Orbit bundles them into one Markdown file that
// goes through the normal upload. Nothing is changed or deleted, and tokens stay in the browser. The one exception is
// sendGmail (gmail.send), which only runs after the student reviews the draft and clicks Send.
//  - Outlook / Outlook Calendar: Microsoft Graph, delegated Mail.Read / Calendars.Read (same Microsoft app as OneDrive).
//  - Gmail / Google Calendar: gmail.readonly ("restricted": fine for test users; public launch needs Google's security
//    assessment) and calendar.readonly ("sensitive": needs Google's app verification before launch).
import { googleToken } from "./google-drive";
import { msToken } from "./onedrive";
import { ConnectorError } from "./types";

export type MailSource = "outlook" | "gmail";
export type MailSummary = { id: string; subject: string; from: string; date: string; snippet: string };
export type MailFull = MailSummary & { to: string; body: string };
export type CalEvent = { id?: string; title: string; start: string; end: string; allDay: boolean; location: string; notes: string };

export const MAIL_LIMITS = { search: 25, pick: 10, bodyChars: 12_000, eventNotes: 400, days: 14 };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** A date-only value ("2026-10-26", Google's all-day events) is a local day, not UTC midnight. */
export const eventDate = (iso: string) => {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
};
const fmt = (iso: string, allDay = false) => {
  const d = eventDate(iso);
  return Number.isNaN(+d) ? iso : d.toLocaleString("en-CA", allDay ? { weekday: "short", month: "short", day: "numeric" } : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

/** Emails → one Markdown file. Pure. */
export function bundleEmails(source: MailSource, mails: MailFull[]): string {
  const head = `# ${source === "gmail" ? "Gmail" : "Outlook"}: ${mails.length} email${mails.length === 1 ? "" : "s"}\n\nImported into Orbit on ${new Date().toISOString().slice(0, 10)} (read-only copy).`;
  const parts = mails.map((m) => `## ${m.subject || "(no subject)"}\n\n- From: ${m.from}\n- To: ${m.to || "—"}\n- Date: ${fmt(m.date)}\n\n${clip(m.body.trim() || m.snippet, MAIL_LIMITS.bodyChars)}`);
  return [head, ...parts].join("\n\n") + "\n";
}

/** Events → one Markdown file, by day. Pure. */
export function bundleEvents(source: "outlook" | "google", events: CalEvent[], from: Date, days = MAIL_LIMITS.days): string {
  const head = `# ${source === "google" ? "Google Calendar" : "Outlook Calendar"}: next ${days} days\n\nFrom ${from.toDateString()}, imported into Orbit on ${new Date().toISOString().slice(0, 10)} (read-only copy). ${events.length} event${events.length === 1 ? "" : "s"}.`;
  if (!events.length) return `${head}\n\nNo events in this period.\n`;
  const byDay = new Map<string, CalEvent[]>();
  for (const e of [...events].sort((a, b) => a.start.localeCompare(b.start))) {
    const day = fmt(e.start, true);
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }
  const parts = [...byDay.entries()].map(([day, es]) => `## ${day}\n\n${es.map((e) => {
    const lastDay = new Date(eventDate(e.end).getTime() - 86_400_000); // all-day ends are exclusive
    const time = e.allDay ? (lastDay.getTime() - eventDate(e.start).getTime() >= 86_400_000 ? `All day, until ${lastDay.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" })}` : "All day") : `${new Date(e.start).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}–${new Date(e.end).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`;
    return `- **${time}** ${e.title || "(no title)"}${e.location ? ` · ${e.location}` : ""}${e.notes ? `\n  ${clip(e.notes.replace(/\s+/g, " ").trim(), MAIL_LIMITS.eventNotes)}` : ""}`;
  }).join("\n")}`);
  return [head, ...parts].join("\n\n") + "\n";
}

/** Plain text from an HTML email body (scripts/styles removed). Pure. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Base64url (Gmail bodies) → UTF-8 text. */
export function decodeB64Url(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: { name: string; value: string }[] };
/** The readable body of a Gmail message: text/plain if present, else text/html as text. Pure. */
export function gmailBody(payload: GmailPart): string {
  const all: GmailPart[] = [];
  const walk = (p: GmailPart) => {
    all.push(p);
    p.parts?.forEach(walk);
  };
  walk(payload);
  const plain = all.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return decodeB64Url(plain.body!.data!);
  const html = all.find((p) => p.mimeType === "text/html" && p.body?.data);
  return html ? htmlToText(decodeB64Url(html.body!.data!)) : "";
}

// ---------------------------------------------------------------- Microsoft (Outlook)
const GRAPH = "https://graph.microsoft.com/v1.0";
async function msGet<T>(path: string, scopes: string[], what: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${GRAPH}${path}`, { headers: { Authorization: `Bearer ${await msToken(scopes, what)}`, ...headers } });
  if (!res.ok) throw new ConnectorError(res.status === 401 || res.status === 403 ? `${what} didn't allow access. Sign in again.` : `Couldn't reach ${what}. Try again.`);
  return (await res.json()) as T;
}
type GraphMail = { id: string; subject?: string; from?: { emailAddress?: { name?: string; address?: string } }; toRecipients?: { emailAddress?: { name?: string; address?: string } }[]; receivedDateTime: string; bodyPreview?: string; body?: { content?: string; contentType?: string } };
const who = (a?: { name?: string; address?: string }) => (a ? (a.name && a.address ? `${a.name} <${a.address}>` : a.name || a.address || "") : "");

export async function searchOutlook(q: string): Promise<MailSummary[]> {
  const sel = "$select=id,subject,from,receivedDateTime,bodyPreview";
  const path = q.trim()
    ? `/me/messages?$search=${encodeURIComponent(`"${q.replace(/"/g, "")}"`)}&$top=${MAIL_LIMITS.search}&${sel}`
    : `/me/messages?$top=${MAIL_LIMITS.search}&$orderby=receivedDateTime desc&${sel}`;
  const out = await msGet<{ value: GraphMail[] }>(path, ["Mail.Read"], "Outlook");
  return out.value.map((m) => ({ id: m.id, subject: m.subject ?? "", from: who(m.from?.emailAddress), date: m.receivedDateTime, snippet: m.bodyPreview ?? "" }));
}
export async function readOutlook(ids: string[]): Promise<MailFull[]> {
  return Promise.all(ids.map(async (id) => {
    const m = await msGet<GraphMail>(`/me/messages/${encodeURIComponent(id)}?$select=id,subject,from,toRecipients,receivedDateTime,body,bodyPreview`, ["Mail.Read"], "Outlook", { Prefer: 'outlook.body-content-type="text"' });
    return { id: m.id, subject: m.subject ?? "", from: who(m.from?.emailAddress), to: (m.toRecipients ?? []).map((r) => who(r.emailAddress)).join(", "), date: m.receivedDateTime, snippet: m.bodyPreview ?? "", body: m.body?.contentType === "html" ? htmlToText(m.body.content ?? "") : m.body?.content ?? "" };
  }));
}
export async function outlookEvents(from = new Date(), days = MAIL_LIMITS.days): Promise<CalEvent[]> {
  const to = new Date(from.getTime() + days * 86_400_000);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const out = await msGet<{ value: { subject?: string; start: { dateTime: string }; end: { dateTime: string }; isAllDay?: boolean; location?: { displayName?: string }; bodyPreview?: string }[] }>(
    `/me/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}&$top=200&$orderby=start/dateTime&$select=subject,start,end,isAllDay,location,bodyPreview`,
    ["Calendars.Read"], "Outlook Calendar", { Prefer: `outlook.timezone="${tz}"` });
  return out.value.map((e) => ({ title: e.subject ?? "", start: e.start.dateTime, end: e.end.dateTime, allDay: Boolean(e.isAllDay), location: e.location?.displayName ?? "", notes: e.bodyPreview ?? "" }));
}

// ---------------------------------------------------------------- Google (Gmail, Calendar)
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
async function gGet<T>(url: string, scope: string, what: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await googleToken([scope])}` } });
  if (!res.ok) throw new ConnectorError(res.status === 401 || res.status === 403 ? `${what} didn't allow access. Sign in again.` : `Couldn't reach ${what}. Try again.`);
  return (await res.json()) as T;
}
type GmailMsg = { id: string; snippet?: string; payload?: GmailPart & { headers?: { name: string; value: string }[] } };
const header = (m: GmailMsg, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

export async function searchGmail(q: string): Promise<MailSummary[]> {
  const list = await gGet<{ messages?: { id: string }[] }>(`${GMAIL}/messages?maxResults=${MAIL_LIMITS.search}${q.trim() ? `&q=${encodeURIComponent(q)}` : ""}`, GMAIL_SCOPE, "Gmail");
  return Promise.all((list.messages ?? []).map(async ({ id }) => {
    const m = await gGet<GmailMsg>(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, GMAIL_SCOPE, "Gmail");
    return { id, subject: header(m, "Subject"), from: header(m, "From"), date: new Date(header(m, "Date") || Date.now()).toISOString(), snippet: m.snippet ?? "" };
  }));
}
// ---------------------------------------------------------------- Gmail: sending (only after the student clicks Send)
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export type EmailDraft = { to: string; cc: string; subject: string; body: string; replyTo?: string };

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
/** "a@x.com, Prof <b@y.ca>" → valid addresses only (throws if one isn't an email). Pure. */
export function parseAddresses(v: string): string[] {
  return v.split(/[,;]/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const addr = (/<([^>]+)>\s*$/.exec(x)?.[1] ?? x).trim();
    if (!ADDRESS.test(addr)) throw new ConnectorError(`"${x}" isn't an email address.`);
    return addr;
  });
}
const b64utf8 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const headerText = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64utf8(s)}?=`);
const noBreaks = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** The raw RFC 2822 message Gmail sends (base64url). Pure. */
export function buildRawEmail(d: { to: string[]; cc: string[]; subject: string; body: string; inReplyTo?: string }): string {
  const lines = [
    `To: ${d.to.join(", ")}`,
    d.cc.length ? `Cc: ${d.cc.join(", ")}` : "",
    `Subject: ${headerText(noBreaks(d.subject))}`,
    d.inReplyTo ? `In-Reply-To: ${noBreaks(d.inReplyTo)}` : "",
    d.inReplyTo ? `References: ${noBreaks(d.inReplyTo)}` : "",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);
  const body = b64utf8(d.body.replace(/\r?\n/g, "\r\n")).replace(/.{76}/g, "$&\r\n");
  return b64utf8(`${lines.join("\r\n")}\r\n\r\n${body}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Send from the student's Gmail. Asks Google for send permission the first time (pop-up: call right after a click). */
/** Checks the draft and, for a reply, finds its thread. Shared by sending and saving a draft. */
async function prepareEmail(d: EmailDraft, needRecipients: boolean) {
  const to = parseAddresses(d.to);
  const cc = parseAddresses(d.cc);
  if (needRecipients && !to.length) throw new ConnectorError("Who should it go to? Add an email address.");
  if (to.length + cc.length > 20) throw new ConnectorError("That's too many recipients (20 at most).");
  if (!d.body.trim()) throw new ConnectorError("The email is empty.");
  let subject = d.subject;
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  if (d.replyTo) {
    // Replying: keep it in the same thread (needs the read permission the student already gave).
    const m = await gGet<GmailMsg & { threadId?: string }>(`${GMAIL}/messages/${encodeURIComponent(d.replyTo)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject`, GMAIL_SCOPE, "Gmail").catch(() => null);
    if (m) {
      threadId = m.threadId;
      inReplyTo = header(m, "Message-ID") || undefined;
      if (!subject.trim()) subject = header(m, "Subject");
      if (subject && !/^re:/i.test(subject)) subject = `Re: ${subject}`;
    }
  }
  return { to, cc, raw: buildRawEmail({ to, cc, subject, body: d.body, inReplyTo }), threadId };
}

/** Send from the student's Gmail. Asks Google for send permission the first time (pop-up: call right after a click). */
export async function sendGmail(d: EmailDraft): Promise<{ id: string; to: string[] }> {
  const e = await prepareEmail(d, true);
  const token = await googleToken([GMAIL_SEND_SCOPE]);
  const res = await fetch(`${GMAIL}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: e.raw, ...(e.threadId ? { threadId: e.threadId } : {}) }),
  }).catch(() => null);
  if (!res) throw new ConnectorError("Couldn't reach Gmail. The email wasn't sent.");
  if (res.status === 401 || res.status === 403) throw new ConnectorError("Gmail didn't allow sending. Sign in again and allow \"Send email on your behalf\".");
  if (!res.ok) throw new ConnectorError(`Gmail couldn't send it (${res.status}). The email wasn't sent.`);
  const j = (await res.json()) as { id?: string };
  return { id: j.id ?? "", to: [...e.to, ...e.cc] };
}

// ---------------------------------------------------------------- Google writes (only after the student confirms)
export const GOOGLE_WRITE_SCOPES = {
  compose: "https://www.googleapis.com/auth/gmail.compose",
  modify: "https://www.googleapis.com/auth/gmail.modify",
  calendar: "https://www.googleapis.com/auth/calendar.events",
} as const;

/** A write call to a Google API with the permission it needs (asked for the first time, right after the student's click). */
export async function gWrite<T>(url: string, scope: string, what: string, init: RequestInit): Promise<T> {
  const token = await googleToken([scope]);
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res) throw new ConnectorError(`Couldn't reach ${what}. Nothing was changed.`);
  if (res.status === 401) throw new ConnectorError(`${what} sign-in expired. Sign in again.`);
  if (res.status === 403) throw new ConnectorError(`${what} didn't allow this change. Sign in again and allow the permission Google asks for.`);
  if (res.status === 404 || res.status === 410) throw new ConnectorError(`Not found in ${what} (it may have been deleted).`);
  if (!res.ok) throw new ConnectorError(`${what} returned an error (${res.status}). Nothing was changed.`);
  return (res.status === 204 ? {} : await res.json().catch(() => ({}))) as T;
}

/** Save a draft in Gmail (not sent). */
export async function draftGmail(d: EmailDraft): Promise<{ id: string }> {
  const e = await prepareEmail(d, false);
  const j = await gWrite<{ id?: string }>(`${GMAIL}/drafts`, GOOGLE_WRITE_SCOPES.compose, "Gmail", {
    method: "POST", body: JSON.stringify({ message: { raw: e.raw, ...(e.threadId ? { threadId: e.threadId } : {}) } }),
  });
  return { id: j.id ?? "" };
}

export const GMAIL_CHANGES = ["mark_read", "mark_unread", "archive", "move_to_inbox", "star", "unstar", "mark_important", "add_label", "remove_label"] as const;
export type GmailChange = (typeof GMAIL_CHANGES)[number];
const IDS = /^[\w-]{6,40}$/;

/** Mark read/unread, archive, star, label… a batch of emails. */
export async function modifyGmail(ids: string[], change: GmailChange, label = ""): Promise<string> {
  const ok = ids.filter((i) => IDS.test(i)).slice(0, 100);
  if (!ok.length) throw new ConnectorError("Which emails? Give ids from gmail_search.");
  const add: string[] = [];
  const remove: string[] = [];
  if (change === "mark_read") remove.push("UNREAD");
  else if (change === "mark_unread") add.push("UNREAD");
  else if (change === "archive") remove.push("INBOX");
  else if (change === "move_to_inbox") add.push("INBOX");
  else if (change === "star") add.push("STARRED");
  else if (change === "unstar") remove.push("STARRED");
  else if (change === "mark_important") add.push("IMPORTANT");
  else {
    const name = label.trim().slice(0, 100);
    if (!name) throw new ConnectorError("Which label?");
    const list = await gWrite<{ labels?: { id: string; name: string }[] }>(`${GMAIL}/labels`, GOOGLE_WRITE_SCOPES.modify, "Gmail", { method: "GET" });
    let id = list.labels?.find((l) => l.name.toLowerCase() === name.toLowerCase())?.id;
    if (!id && change === "remove_label") throw new ConnectorError(`There's no label called "${name}".`);
    if (!id) id = (await gWrite<{ id: string }>(`${GMAIL}/labels`, GOOGLE_WRITE_SCOPES.modify, "Gmail", { method: "POST", body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }) })).id;
    (change === "add_label" ? add : remove).push(id);
  }
  await gWrite(`${GMAIL}/messages/batchModify`, GOOGLE_WRITE_SCOPES.modify, "Gmail", { method: "POST", body: JSON.stringify({ ids: ok, addLabelIds: add, removeLabelIds: remove }) });
  return `Done (${change.replace(/_/g, " ")}${label ? ` "${label}"` : ""}) for ${ok.length} email${ok.length === 1 ? "" : "s"}.`;
}

/** Move emails to Trash (recoverable for 30 days). */
export async function trashGmail(ids: string[]): Promise<string> {
  const ok = ids.filter((i) => IDS.test(i)).slice(0, 50);
  if (!ok.length) throw new ConnectorError("Which emails? Give ids from gmail_search.");
  for (const id of ok) await gWrite(`${GMAIL}/messages/${id}/trash`, GOOGLE_WRITE_SCOPES.modify, "Gmail", { method: "POST" });
  return `Moved ${ok.length} email${ok.length === 1 ? "" : "s"} to Trash (recoverable for 30 days).`;
}

// Calendar times from the AI: "2026-10-20T14:00" (local time) or "2026-10-20" (all day).
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/;
const pad = (n: number) => String(n).padStart(2, "0");
const localStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
/** {start, end} in Google's format; a missing end = 1 hour later (or the same day for all-day). Pure apart from the time zone. */
export function eventTimes(start: string, end: string, tz: string): { start: Record<string, string>; end: Record<string, string> } {
  const s = start.trim();
  const e = end.trim();
  const d = DAY.exec(s);
  if (d) {
    const endDay = DAY.test(e) ? e : null;
    const next = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + 1);
    // Google's all-day end is the day after the last day.
    const last = endDay ? new Date(Number(endDay.slice(0, 4)), Number(endDay.slice(5, 7)) - 1, Number(endDay.slice(8, 10)) + 1) : next;
    const day = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
    return { start: { date: s }, end: { date: day(last > next ? last : next) } };
  }
  const m = LOCAL.exec(s);
  if (!m) throw new ConnectorError(`"${s}" isn't a time I understand. Use 2026-10-20T14:00 or 2026-10-20.`);
  const startD = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const em = LOCAL.exec(e);
  let endD = em ? new Date(Number(em[1]), Number(em[2]) - 1, Number(em[3]), Number(em[4]), Number(em[5])) : new Date(startD.getTime() + 3_600_000);
  if (endD <= startD) endD = new Date(startD.getTime() + 3_600_000);
  return { start: { dateTime: localStr(startD), timeZone: tz }, end: { dateTime: localStr(endD), timeZone: tz } };
}
const GCAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const tzNow = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export type EventInput = { title?: string; start?: string; end?: string; location?: string; description?: string };

export async function createGoogleEvent(e: EventInput): Promise<string> {
  if (!e.title?.trim()) throw new ConnectorError("What's the event called?");
  if (!e.start?.trim()) throw new ConnectorError("When is it?");
  const j = await gWrite<{ htmlLink?: string; summary?: string }>(GCAL, GOOGLE_WRITE_SCOPES.calendar, "Google Calendar", {
    method: "POST",
    body: JSON.stringify({ summary: e.title.trim().slice(0, 300), ...eventTimes(e.start, e.end ?? "", tzNow()), ...(e.location ? { location: e.location.slice(0, 300) } : {}), ...(e.description ? { description: e.description.slice(0, 8000) } : {}) }),
  });
  return `Added "${j.summary ?? e.title}" to Google Calendar.\n${j.htmlLink ?? ""}`;
}
export async function updateGoogleEvent(id: string, e: EventInput): Promise<string> {
  if (!/^[\w-]{5,1024}$/.test(id)) throw new ConnectorError("Which event? Give an id from google_calendar_events.");
  const patch: Record<string, unknown> = {};
  if (e.title?.trim()) patch.summary = e.title.trim().slice(0, 300);
  if (e.location !== undefined && e.location !== "") patch.location = e.location.slice(0, 300);
  if (e.description !== undefined && e.description !== "") patch.description = e.description.slice(0, 8000);
  if (e.start?.trim()) Object.assign(patch, eventTimes(e.start, e.end ?? "", tzNow()));
  if (!Object.keys(patch).length) throw new ConnectorError("Nothing to change.");
  const j = await gWrite<{ htmlLink?: string; summary?: string }>(`${GCAL}/${encodeURIComponent(id)}`, GOOGLE_WRITE_SCOPES.calendar, "Google Calendar", { method: "PATCH", body: JSON.stringify(patch) });
  return `Updated "${j.summary ?? "the event"}".\n${j.htmlLink ?? ""}`;
}
export async function deleteGoogleEvent(id: string): Promise<string> {
  if (!/^[\w-]{5,1024}$/.test(id)) throw new ConnectorError("Which event? Give an id from google_calendar_events.");
  await gWrite(`${GCAL}/${encodeURIComponent(id)}`, GOOGLE_WRITE_SCOPES.calendar, "Google Calendar", { method: "DELETE" });
  return "Deleted the event.";
}

export async function readGmail(ids: string[]): Promise<MailFull[]> {
  return Promise.all(ids.map(async (id) => {
    const m = await gGet<GmailMsg>(`${GMAIL}/messages/${id}?format=full`, GMAIL_SCOPE, "Gmail");
    return { id, subject: header(m, "Subject"), from: header(m, "From"), to: header(m, "To"), date: new Date(header(m, "Date") || Date.now()).toISOString(), snippet: m.snippet ?? "", body: m.payload ? gmailBody(m.payload) : "" };
  }));
}
export async function googleEvents(from = new Date(), days = MAIL_LIMITS.days): Promise<CalEvent[]> {
  const to = new Date(from.getTime() + days * 86_400_000);
  const out = await gGet<{ items?: { id?: string; summary?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; location?: string; description?: string }[] }>(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=200&timeMin=${from.toISOString()}&timeMax=${to.toISOString()}`, GCAL_SCOPE, "Google Calendar");
  return (out.items ?? []).map((e) => ({
    id: e.id, title: e.summary ?? "", start: e.start.dateTime ?? e.start.date ?? "", end: e.end.dateTime ?? e.end.date ?? "", allDay: !e.start.dateTime,
    location: e.location ?? "", notes: e.description ? htmlToText(e.description) : "",
  }));
}
