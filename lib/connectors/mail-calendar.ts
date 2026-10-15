// Email and calendar connectors (integration memo #5–6): read-only. The student searches their inbox and ticks the
// emails to bring in, or brings in their next two weeks of events; Orbit bundles them into one Markdown file that
// goes through the normal upload. Nothing is sent, changed or deleted, and tokens stay in the browser.
//  - Outlook / Outlook Calendar: Microsoft Graph, delegated Mail.Read / Calendars.Read (same Microsoft app as OneDrive).
//  - Gmail / Google Calendar: gmail.readonly ("restricted": fine for test users; public launch needs Google's security
//    assessment) and calendar.readonly ("sensitive": needs Google's app verification before launch).
import { googleToken } from "./google-drive";
import { msToken } from "./onedrive";
import { ConnectorError } from "./types";

export type MailSource = "outlook" | "gmail";
export type MailSummary = { id: string; subject: string; from: string; date: string; snippet: string };
export type MailFull = MailSummary & { to: string; body: string };
export type CalEvent = { title: string; start: string; end: string; allDay: boolean; location: string; notes: string };

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
export async function readGmail(ids: string[]): Promise<MailFull[]> {
  return Promise.all(ids.map(async (id) => {
    const m = await gGet<GmailMsg>(`${GMAIL}/messages/${id}?format=full`, GMAIL_SCOPE, "Gmail");
    return { id, subject: header(m, "Subject"), from: header(m, "From"), to: header(m, "To"), date: new Date(header(m, "Date") || Date.now()).toISOString(), snippet: m.snippet ?? "", body: m.payload ? gmailBody(m.payload) : "" };
  }));
}
export async function googleEvents(from = new Date(), days = MAIL_LIMITS.days): Promise<CalEvent[]> {
  const to = new Date(from.getTime() + days * 86_400_000);
  const out = await gGet<{ items?: { summary?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; location?: string; description?: string }[] }>(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=200&timeMin=${from.toISOString()}&timeMax=${to.toISOString()}`, GCAL_SCOPE, "Google Calendar");
  return (out.items ?? []).map((e) => ({
    title: e.summary ?? "", start: e.start.dateTime ?? e.start.date ?? "", end: e.end.dateTime ?? e.end.date ?? "", allDay: !e.start.dateTime,
    location: e.location ?? "", notes: e.description ? htmlToText(e.description) : "",
  }));
}
