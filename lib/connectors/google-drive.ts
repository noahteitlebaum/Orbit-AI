// Google Drive: Google's own file picker. Permission is "drive.file" — Orbit can only open the files the student
// picks (not browse their Drive), it's a non-sensitive scope, so Google doesn't require an app security review.
// Google Docs/Sheets/Slides are converted to Word/Excel/PowerPoint so the normal file reader handles them.
import { ConnectorError, MAX_CLOUD_FILE_BYTES, MAX_CLOUD_FILES } from "./types";
import { loadScript } from "./load-script";

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_PICKER_KEY ?? "";
const APP_ID = process.env.NEXT_PUBLIC_GOOGLE_APP_ID ?? ""; // Cloud project number
const SCOPE = "https://www.googleapis.com/auth/drive.file";

export const googleDriveConfigured = Boolean(CLIENT_ID && API_KEY && APP_ID);
/** Gmail / Calendar only need the OAuth client (no picker key). */
export const googleConfigured = Boolean(CLIENT_ID);

/** Google's editor formats → a file type our reader understands. Pure, for tests. */
export const GOOGLE_EXPORTS: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  "application/vnd.google-apps.spreadsheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  "application/vnd.google-apps.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" },
  "application/vnd.google-apps.drawing": { mime: "application/pdf", ext: "pdf" },
};

/** Where to download a picked file from, and its file name. Pure, for tests. */
export function driveDownload(doc: { id: string; name: string; mimeType: string }): { url: string; name: string } | null {
  const id = encodeURIComponent(doc.id);
  const exp = GOOGLE_EXPORTS[doc.mimeType];
  if (exp) {
    const name = doc.name.toLowerCase().endsWith(`.${exp.ext}`) ? doc.name : `${doc.name}.${exp.ext}`;
    return { url: `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exp.mime)}`, name };
  }
  if (doc.mimeType.startsWith("application/vnd.google-apps.")) return null; // forms, sites, folders… can't be read
  return { url: `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, name: doc.name };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// Access tokens (1 hour) are kept in this browser so a reload doesn't ask again; Google gives browsers no refresh token,
// so after an hour the student taps Connect once more.
const TOKENS_KEY = "orbit.google.tokens";
const tokens = new Map<string, { value: string; expires: number }>(
  (() => {
    try {
      return Object.entries(JSON.parse(localStorage.getItem(TOKENS_KEY) ?? "{}") as Record<string, { value: string; expires: number }>);
    } catch {
      return [];
    }
  })(),
);
function saveTokens() {
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify(Object.fromEntries([...tokens].filter(([, t]) => t.expires > Date.now()))));
  } catch {}
}
/** A still-valid token for these scopes without any pop-up, or null. */
export function googleTokenCached(scopes: string[]): string | null {
  const t = tokens.get(scopes.join(" "));
  return t && t.expires > Date.now() + 60_000 ? t.value : null;
}
export function googleSignOut() {
  const g = (globalThis as { google?: { accounts?: { oauth2?: { revoke?: (t: string) => void } } } }).google;
  for (const t of tokens.values()) g?.accounts?.oauth2?.revoke?.(t.value);
  tokens.clear();
  saveTokens();
}

/** A Google access token for these scopes (Google's own consent pop-up the first time). Kept in memory only. */
export async function googleToken(scopes: string[]): Promise<string> {
  const key = scopes.join(" ");
  const have = tokens.get(key);
  if (have && have.expires > Date.now() + 60_000) return have.value;
  await loadScript("https://accounts.google.com/gsi/client");
  const g = (window as any).google;
  return new Promise((resolve, reject) => {
    const client = g.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: key,
      callback: (r: any) => {
        if (r.error || !r.access_token) return reject(new ConnectorError("Google sign-in was cancelled."));
        if (!scopes.every((s) => g.accounts.oauth2.hasGrantedAllScopes(r, s))) return reject(new ConnectorError("Orbit needs the permission you unticked to do this. Try again and allow it."));
        tokens.set(key, { value: r.access_token, expires: Date.now() + (Number(r.expires_in) || 3000) * 1000 });
        saveTokens();
        resolve(r.access_token);
      },
      error_callback: () => reject(new ConnectorError("Google sign-in was cancelled or blocked (allow pop-ups for Orbit).")),
    });
    client.requestAccessToken({ prompt: "" });
  });
}
const accessToken = () => googleToken([SCOPE]);

/** Open Google's picker; resolves with the chosen files downloaded (empty if the student cancelled). */
export async function pickFromGoogleDrive(onStatus?: (s: string) => void): Promise<File[]> {
  if (!googleDriveConfigured) throw new ConnectorError("Google Drive isn't set up yet.");
  const t = await accessToken();
  await loadScript("https://apis.google.com/js/api.js");
  const gapi = (window as any).gapi;
  await new Promise<void>((resolve) => gapi.load("picker", { callback: resolve }));
  const p = (window as any).google.picker;
  const docs: { id: string; name: string; mimeType: string; sizeBytes?: number }[] = await new Promise((resolve) => {
    const view = new p.DocsView().setIncludeFolders(true).setSelectFolderEnabled(false);
    const picker = new p.PickerBuilder()
      .addView(view)
      .addView(new p.DocsUploadView())
      .enableFeature(p.Feature.MULTISELECT_ENABLED)
      .setMaxItems(MAX_CLOUD_FILES)
      .setOAuthToken(t)
      .setDeveloperKey(API_KEY)
      .setAppId(APP_ID)
      .setTitle("Choose files for Orbit")
      .setCallback((data: any) => {
        if (data.action === p.Action.PICKED) resolve(data.docs ?? []);
        else if (data.action === p.Action.CANCEL) resolve([]);
      })
      .build();
    picker.setVisible(true);
  });
  const files: File[] = [];
  for (const d of docs.slice(0, MAX_CLOUD_FILES)) {
    const where = driveDownload(d);
    if (!where) throw new ConnectorError(`${d.name} is a Google ${d.mimeType.split(".").pop()} — Orbit can read Docs, Sheets, Slides and regular files.`);
    if (d.sizeBytes && d.sizeBytes > MAX_CLOUD_FILE_BYTES) throw new ConnectorError(`${d.name} is too large (max 30 MB).`);
    onStatus?.(`Getting ${where.name} from Google Drive…`);
    const res = await fetch(where.url, { headers: { Authorization: `Bearer ${t}` } });
    if (!res.ok) throw new ConnectorError(res.status === 403 ? `Google wouldn't share ${d.name} (it may be too large to convert, or restricted by its owner).` : `Couldn't download ${d.name} from Google Drive.`);
    const blob = await res.blob();
    files.push(new File([blob], where.name, { type: blob.type || "application/octet-stream" }));
  }
  return files;
}
