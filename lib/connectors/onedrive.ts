// OneDrive (personal and Western's Microsoft 365): Microsoft sign-in pop-up with "Files.Read" (read the student's own
// files, nothing else), then a small file browser over Microsoft Graph. Picked files go through the normal upload.
import { ConnectorError, MAX_CLOUD_FILE_BYTES } from "./types";

const CLIENT_ID = process.env.NEXT_PUBLIC_MICROSOFT_CLIENT_ID ?? "";
const SCOPES = ["Files.Read"];
const GRAPH = "https://graph.microsoft.com/v1.0";

export const oneDriveConfigured = Boolean(CLIENT_ID);

export type DriveItem = { id: string; name: string; size?: number; folder?: { childCount?: number }; file?: { mimeType?: string }; lastModifiedDateTime?: string };

/** Sort folders first, then by name. Pure, for tests. */
export function sortItems(items: DriveItem[]): DriveItem[] {
  return [...items].sort((a, b) => Number(Boolean(b.folder)) - Number(Boolean(a.folder)) || a.name.localeCompare(b.name));
}

type Msal = import("@azure/msal-browser").IPublicClientApplication;
let msal: Promise<Msal> | null = null;
function client(): Promise<Msal> {
  msal ??= import("@azure/msal-browser").then(({ createStandardPublicClientApplication }) =>
    createStandardPublicClientApplication({
      auth: { clientId: CLIENT_ID, authority: "https://login.microsoftonline.com/common", redirectUri: `${window.location.origin}/auth/microsoft` },
      cache: { cacheLocation: "sessionStorage" }, // forgotten when the tab closes
    }),
  );
  return msal;
}

/** A Microsoft Graph token for these delegated permissions (asks for consent the first time each is needed). */
export async function msToken(scopes: string[] = SCOPES, what = "OneDrive"): Promise<string> {
  const app = await client();
  const account = app.getAllAccounts()[0];
  if (account) {
    try {
      return (await app.acquireTokenSilent({ scopes, account })).accessToken;
    } catch {}
  }
  try {
    const r = await app.acquireTokenPopup({ scopes, prompt: account ? undefined : "select_account" });
    return r.accessToken;
  } catch (e) {
    const msg = String((e as Error)?.message ?? "");
    if (/consent|admin/i.test(msg)) throw new ConnectorError(`Your school account needs an administrator to approve Orbit for ${what}. Try a personal Microsoft account, or upload/paste it instead.`);
    throw new ConnectorError("Microsoft sign-in was cancelled or blocked (allow pop-ups for Orbit).");
  }
}

const token = () => msToken();

async function graph<T>(path: string): Promise<T> {
  const res = await fetch(`${GRAPH}${path}`, { headers: { Authorization: `Bearer ${await token()}` } });
  if (!res.ok) throw new ConnectorError(res.status === 401 || res.status === 403 ? "OneDrive didn't allow access. Sign in again." : "Couldn't reach OneDrive. Try again.");
  return (await res.json()) as T;
}

const SELECT = "$select=id,name,size,folder,file,lastModifiedDateTime&$top=200";

export async function listOneDrive(folderId: string | null): Promise<DriveItem[]> {
  const path = folderId ? `/me/drive/items/${encodeURIComponent(folderId)}/children?${SELECT}` : `/me/drive/root/children?${SELECT}`;
  return sortItems((await graph<{ value: DriveItem[] }>(path)).value ?? []);
}

export async function searchOneDrive(q: string): Promise<DriveItem[]> {
  const safe = q.replace(/'/g, "''").slice(0, 100);
  return sortItems((await graph<{ value: DriveItem[] }>(`/me/drive/root/search(q='${encodeURIComponent(safe)}')?${SELECT}`)).value ?? []);
}

export async function downloadOneDrive(item: DriveItem): Promise<File> {
  if (item.size && item.size > MAX_CLOUD_FILE_BYTES) throw new ConnectorError(`${item.name} is too large (max 30 MB).`);
  const meta = await graph<{ "@microsoft.graph.downloadUrl"?: string }>(`/me/drive/items/${encodeURIComponent(item.id)}?$select=id,@microsoft.graph.downloadUrl`);
  const url = meta["@microsoft.graph.downloadUrl"];
  if (!url) throw new ConnectorError(`Couldn't download ${item.name} from OneDrive.`);
  const res = await fetch(url); // short-lived pre-signed link: no token needed
  if (!res.ok) throw new ConnectorError(`Couldn't download ${item.name} from OneDrive.`);
  const blob = await res.blob();
  return new File([blob], item.name, { type: item.file?.mimeType || blob.type || "application/octet-stream" });
}

export async function signOutOneDrive() {
  const app = await client();
  const account = app.getAllAccounts()[0];
  if (account) await app.clearCache({ account });
}
