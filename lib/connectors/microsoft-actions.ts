// Changes in the student's Microsoft account (Outlook mail, Outlook Calendar, OneDrive) through Microsoft Graph.
// Only run after the student confirms the change in the chat (components/folder-activity.tsx). Each asks Microsoft for
// the permission it needs the first time (a pop-up, right after the student's click).
import { eventTimes } from "./mail-calendar";
import { msToken } from "./onedrive";
import { ConnectorError } from "./types";

const GRAPH = "https://graph.microsoft.com/v1.0";
export const MS_WRITE_SCOPES = { send: "Mail.Send", mail: "Mail.ReadWrite", calendar: "Calendars.ReadWrite", files: "Files.ReadWrite" } as const;

/** A Graph write call. Throws a readable error; returns the JSON body (or {} for 204). */
async function msWrite<T>(path: string, scope: string, what: string, init: RequestInit & { raw?: boolean } = {}): Promise<T> {
  const token = await msToken([scope], what);
  const res = await fetch(path.startsWith("https://") ? path : `${GRAPH}${path}`, {
    ...init, headers: { ...(init.raw ? {} : { "Content-Type": "application/json" }), ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!res) throw new ConnectorError(`Couldn't reach ${what}. Nothing was changed.`);
  if (res.status === 401) throw new ConnectorError(`${what} sign-in expired. Sign in again.`);
  if (res.status === 403) throw new ConnectorError(`${what} didn't allow this change. Sign in again and accept the permission Microsoft asks for (school accounts may need IT to approve Orbit).`);
  if (res.status === 404) throw new ConnectorError(`Not found in ${what} (it may have been moved or deleted).`);
  if (res.status === 409) throw new ConnectorError(`Something with that name already exists in ${what}.`);
  if (!res.ok) throw new ConnectorError(`${what} returned an error (${res.status}). Nothing was changed.`);
  return (res.status === 204 || res.status === 202 ? {} : await res.json().catch(() => ({}))) as T;
}

const ID = /^[\w=+/.!-]{5,400}$/;
const needId = (id: string, what: string) => { if (!ID.test(id)) throw new ConnectorError(`Give ${what} id from the search results.`); return encodeURIComponent(id); };
const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
/** "a@x.com, Prof <b@y.ca>" → Graph recipients (throws on anything that isn't an email). Pure. */
export function recipients(v: string): { emailAddress: { address: string } }[] {
  return v.split(/[,;]/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const address = (/<([^>]+)>\s*$/.exec(x)?.[1] ?? x).trim();
    if (!ADDRESS.test(address)) throw new ConnectorError(`"${x}" isn't an email address.`);
    return { emailAddress: { address } };
  });
}

// ---------------------------------------------------------------- Outlook mail
export type OutlookDraft = { to: string; cc: string; subject: string; body: string; replyTo?: string };

export async function sendOutlook(d: OutlookDraft): Promise<string> {
  if (!d.body.trim()) throw new ConnectorError("The email is empty.");
  if (d.replyTo) {
    // A reply keeps the thread and quotes the original, like Reply in Outlook.
    await msWrite(`/me/messages/${needId(d.replyTo, "the email's")}/reply`, MS_WRITE_SCOPES.send, "Outlook", {
      method: "POST", body: JSON.stringify({ comment: d.body, ...(d.to.trim() ? { message: { toRecipients: recipients(d.to), ...(d.cc.trim() ? { ccRecipients: recipients(d.cc) } : {}) } } : {}) }),
    });
    return "Sent the reply.";
  }
  const to = recipients(d.to);
  if (!to.length) throw new ConnectorError("Who should it go to? Add an email address.");
  await msWrite("/me/sendMail", MS_WRITE_SCOPES.send, "Outlook", {
    method: "POST",
    body: JSON.stringify({ message: { subject: d.subject, body: { contentType: "Text", content: d.body }, toRecipients: to, ccRecipients: recipients(d.cc) }, saveToSentItems: true }),
  });
  return `Sent to ${to.map((r) => r.emailAddress.address).join(", ")}.`;
}

export async function draftOutlook(d: OutlookDraft): Promise<string> {
  if (!d.body.trim()) throw new ConnectorError("The email is empty.");
  if (d.replyTo) {
    await msWrite(`/me/messages/${needId(d.replyTo, "the email's")}/createReply`, MS_WRITE_SCOPES.mail, "Outlook", { method: "POST", body: JSON.stringify({ comment: d.body }) });
    return "Saved a reply draft in Outlook (not sent).";
  }
  await msWrite("/me/messages", MS_WRITE_SCOPES.mail, "Outlook", {
    method: "POST",
    body: JSON.stringify({ subject: d.subject, body: { contentType: "Text", content: d.body }, toRecipients: recipients(d.to), ccRecipients: recipients(d.cc) }),
  });
  return "Saved as a draft in Outlook (not sent).";
}

export const OUTLOOK_CHANGES = ["mark_read", "mark_unread", "archive", "move_to_inbox", "flag", "unflag", "add_category", "remove_category"] as const;
export type OutlookChange = (typeof OUTLOOK_CHANGES)[number];

export async function modifyOutlook(ids: string[], change: OutlookChange, category = ""): Promise<string> {
  const list = ids.filter((i) => ID.test(i)).slice(0, 50);
  if (!list.length) throw new ConnectorError("Which emails? Give ids from outlook_search.");
  const cat = category.trim().slice(0, 100);
  if ((change === "add_category" || change === "remove_category") && !cat) throw new ConnectorError("Which category?");
  for (const id of list) {
    const path = `/me/messages/${encodeURIComponent(id)}`;
    if (change === "archive" || change === "move_to_inbox") {
      await msWrite(`${path}/move`, MS_WRITE_SCOPES.mail, "Outlook", { method: "POST", body: JSON.stringify({ destinationId: change === "archive" ? "archive" : "inbox" }) });
      continue;
    }
    let patch: object;
    if (change === "mark_read" || change === "mark_unread") patch = { isRead: change === "mark_read" };
    else if (change === "flag" || change === "unflag") patch = { flag: { flagStatus: change === "flag" ? "flagged" : "notFlagged" } };
    else {
      const m = await msWrite<{ categories?: string[] }>(`${path}?$select=categories`, MS_WRITE_SCOPES.mail, "Outlook", { method: "GET" });
      const now = m.categories ?? [];
      patch = { categories: change === "add_category" ? [...new Set([...now, cat])] : now.filter((c) => c.toLowerCase() !== cat.toLowerCase()) };
    }
    await msWrite(path, MS_WRITE_SCOPES.mail, "Outlook", { method: "PATCH", body: JSON.stringify(patch) });
  }
  return `Done (${change.replace(/_/g, " ")}${cat ? ` "${cat}"` : ""}) for ${list.length} email${list.length === 1 ? "" : "s"}.`;
}

export async function trashOutlook(ids: string[]): Promise<string> {
  const list = ids.filter((i) => ID.test(i)).slice(0, 50);
  if (!list.length) throw new ConnectorError("Which emails? Give ids from outlook_search.");
  for (const id of list) await msWrite(`/me/messages/${encodeURIComponent(id)}/move`, MS_WRITE_SCOPES.mail, "Outlook", { method: "POST", body: JSON.stringify({ destinationId: "deleteditems" }) });
  return `Moved ${list.length} email${list.length === 1 ? "" : "s"} to Deleted Items.`;
}

// ---------------------------------------------------------------- Outlook Calendar
export type MsEventInput = { title?: string; start?: string; end?: string; location?: string; description?: string };
const tzNow = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Graph's start/end (+ isAllDay) from "2026-10-20T14:00" or "2026-10-20". Pure apart from the time zone. */
export function msEventTimes(start: string, end: string, tz: string) {
  const t = eventTimes(start, end, tz);
  if (t.start.date) return { isAllDay: true, start: { dateTime: `${t.start.date}T00:00:00`, timeZone: tz }, end: { dateTime: `${t.end.date}T00:00:00`, timeZone: tz } };
  return { isAllDay: false, start: { dateTime: t.start.dateTime, timeZone: tz }, end: { dateTime: t.end.dateTime, timeZone: tz } };
}
export async function createOutlookEvent(e: MsEventInput): Promise<string> {
  if (!e.title?.trim()) throw new ConnectorError("What's the event called?");
  if (!e.start?.trim()) throw new ConnectorError("When is it?");
  const j = await msWrite<{ subject?: string; webLink?: string }>("/me/events", MS_WRITE_SCOPES.calendar, "Outlook Calendar", {
    method: "POST",
    body: JSON.stringify({ subject: e.title.trim().slice(0, 300), ...msEventTimes(e.start, e.end ?? "", tzNow()),
      ...(e.location ? { location: { displayName: e.location.slice(0, 300) } } : {}), ...(e.description ? { body: { contentType: "text", content: e.description.slice(0, 8000) } } : {}) }),
  });
  return `Added "${j.subject ?? e.title}" to Outlook Calendar.\n${j.webLink ?? ""}`;
}
export async function updateOutlookEvent(id: string, e: MsEventInput): Promise<string> {
  const safe = needId(id, "an event");
  const patch: Record<string, unknown> = {};
  if (e.title?.trim()) patch.subject = e.title.trim().slice(0, 300);
  if (e.location) patch.location = { displayName: e.location.slice(0, 300) };
  if (e.description) patch.body = { contentType: "text", content: e.description.slice(0, 8000) };
  if (e.start?.trim()) Object.assign(patch, msEventTimes(e.start, e.end ?? "", tzNow()));
  if (!Object.keys(patch).length) throw new ConnectorError("Nothing to change.");
  const j = await msWrite<{ subject?: string; webLink?: string }>(`/me/events/${safe}`, MS_WRITE_SCOPES.calendar, "Outlook Calendar", { method: "PATCH", body: JSON.stringify(patch) });
  return `Updated "${j.subject ?? "the event"}".\n${j.webLink ?? ""}`;
}
export async function deleteOutlookEvent(id: string): Promise<string> {
  await msWrite(`/me/events/${needId(id, "an event")}`, MS_WRITE_SCOPES.calendar, "Outlook Calendar", { method: "DELETE" });
  return "Deleted the event.";
}

// ---------------------------------------------------------------- OneDrive
type Item = { id?: string; name?: string; webUrl?: string; parentReference?: { id?: string } };
const cleanName = (n: string) => n.replace(/[\r\n]+/g, " ").replace(/[\\/:*?"<>|]/g, "-").trim().slice(0, 200);
const parentPath = (folder: string) => (folder ? `/me/drive/items/${needId(folder, "a folder")}` : "/me/drive/root");

export async function renameOneDrive(id: string, name: string): Promise<string> {
  const n = cleanName(name);
  if (!n) throw new ConnectorError("What should the new name be?");
  const j = await msWrite<Item>(`/me/drive/items/${needId(id, "a file")}`, MS_WRITE_SCOPES.files, "OneDrive", { method: "PATCH", body: JSON.stringify({ name: n }) });
  return `Renamed to "${j.name ?? n}".\n${j.webUrl ?? ""}`;
}
export async function createOneDriveFolder(name: string, parent = ""): Promise<string> {
  const n = cleanName(name);
  if (!n) throw new ConnectorError("What should the folder be called?");
  const j = await msWrite<Item>(`${parentPath(parent)}/children`, MS_WRITE_SCOPES.files, "OneDrive", {
    method: "POST", body: JSON.stringify({ name: n, folder: {}, "@microsoft.graph.conflictBehavior": "rename" }),
  });
  return `Created the folder "${j.name ?? n}" (id ${j.id}).\n${j.webUrl ?? ""}`;
}
export async function moveOneDrive(id: string, folder: string): Promise<string> {
  needId(folder, "a folder");
  const j = await msWrite<Item>(`/me/drive/items/${needId(id, "a file")}`, MS_WRITE_SCOPES.files, "OneDrive", {
    method: "PATCH", body: JSON.stringify({ parentReference: { id: folder } }),
  });
  return `Moved "${j.name ?? "it"}".\n${j.webUrl ?? ""}`;
}
export async function trashOneDrive(id: string): Promise<string> {
  await msWrite(`/me/drive/items/${needId(id, "a file")}`, MS_WRITE_SCOPES.files, "OneDrive", { method: "DELETE" });
  return "Moved it to the OneDrive recycle bin (restorable from there).";
}
/** Upload new content (a Word file from Markdown, or plain text) as a new file, or replace an existing file's content. */
export async function uploadOneDrive(target: { folder?: string; name?: string; id?: string }, body: Blob): Promise<string> {
  const path = target.id
    ? `/me/drive/items/${needId(target.id, "a file")}/content`
    : `${parentPath(target.folder ?? "")}:/${encodeURIComponent(cleanName(target.name ?? "") || "Untitled.txt")}:/content?@microsoft.graph.conflictBehavior=rename`;
  if (body.size > 4 * 1024 * 1024) throw new ConnectorError("That's too large to save in one go (4 MB).");
  const j = await msWrite<Item>(path, MS_WRITE_SCOPES.files, "OneDrive", { method: "PUT", raw: true, headers: { "Content-Type": body.type || "application/octet-stream" }, body });
  return `${target.id ? "Updated" : "Saved"} "${j.name ?? target.name}"${j.id && !target.id ? ` (id ${j.id})` : ""}.\n${j.webUrl ?? ""}`;
}

/** Excel: column letter for a 1-based index. Pure. */
export const colLetter = (n: number): string => (n <= 0 ? "" : colLetter(Math.floor((n - 1) / 26)) + String.fromCharCode(65 + ((n - 1) % 26)));
/** Add rows under the last used row of an Excel workbook's sheet (first sheet if none given). */
export async function appendExcelRows(id: string, rows: string[][], sheet = ""): Promise<string> {
  const safe = needId(id, "a workbook");
  if (!rows.length) throw new ConnectorError("No rows to add.");
  const book = `/me/drive/items/${safe}/workbook/worksheets`;
  const name = sheet.trim() || (await msWrite<{ value?: { name: string }[] }>(`${book}?$select=name`, MS_WRITE_SCOPES.files, "Excel", { method: "GET" })).value?.[0]?.name;
  if (!name) throw new ConnectorError("That workbook has no sheets.");
  const ws = `${book}/${encodeURIComponent(name)}`;
  const used = await msWrite<{ address?: string; rowCount?: number }>(`${ws}/usedRange(valuesOnly=true)?$select=address,rowCount`, MS_WRITE_SCOPES.files, "Excel", { method: "GET" });
  // "Sheet1!A1:D12" → next row 13 (an empty sheet reports A1 with one row).
  const last = Number(/(\d+)$/.exec(used.address ?? "")?.[1] ?? 0);
  let first = last + 1;
  if (/!A1$/.test(used.address ?? "")) {
    // One cell used, or none at all: an empty sheet starts at row 1.
    const a1 = await msWrite<{ values?: unknown[][] }>(`${ws}/range(address='A1')?$select=values`, MS_WRITE_SCOPES.files, "Excel", { method: "GET" });
    if (a1.values?.[0]?.[0] === "" || a1.values?.[0]?.[0] == null) first = 1;
  }
  const width = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => [...r, ...Array(width - r.length).fill("")]);
  const address = `A${first}:${colLetter(width)}${first + padded.length - 1}`;
  await msWrite(`${ws}/range(address='${address}')`, MS_WRITE_SCOPES.files, "Excel", { method: "PATCH", body: JSON.stringify({ values: padded }) });
  return `Added ${padded.length} row${padded.length === 1 ? "" : "s"} to ${name} (${address}).`;
}
