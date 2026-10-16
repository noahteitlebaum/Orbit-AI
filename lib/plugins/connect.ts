// Browser: is a plugin set up on this server, is the student signed in, and connect / disconnect.
// Sign-ins stay in this browser (never on our server), like the rest of lib/connectors.
import { githubAuth, githubSignInConfigured, githubToken, setGithubToken } from "@/lib/connectors/github";
import { googleConfigured, googleSignOut, googleToken, googleTokenCached } from "@/lib/connectors/google-drive";
import { notionSession, notionSignInConfigured, setNotionSession, signInToNotion } from "@/lib/connectors/notion-client";
import { msSignOut, msToken, msTokenSilent, oneDriveConfigured } from "@/lib/connectors/onedrive";
import { setZoteroAuth, zoteroAuth } from "@/lib/connectors/zotero";
import { PLUGIN_BY_ID, type PluginId, type PluginInfo } from "./catalog";

// Plugins that need a server key (Wolfram|Alpha) — filled in once from /api/plugins/public.
let serverReady: Set<string> | null = null;
export async function loadServerReady(): Promise<void> {
  const j = (await fetch("/api/plugins/public").then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { ready?: string[] } | null;
  serverReady = new Set(Array.isArray(j?.ready) ? j.ready.filter((x): x is string => typeof x === "string") : []);
}

/** Whether the team has set this plugin's keys (otherwise students can't connect it yet). */
export function pluginConfigured(p: PluginInfo): boolean {
  switch (p.auth) {
    case "server": return serverReady?.has(p.id) ?? false;
    case "github": return true; // public repos work without sign-in; private ones need NEXT_PUBLIC_GITHUB_CLIENT_ID
    case "google": return googleConfigured;
    case "microsoft": return oneDriveConfigured;
    case "notion": return notionSignInConfigured;
    default: return true;
  }
}

/** Signed in right now, without any pop-up. GitHub without sign-in still works for public repos ("limited"). */
export async function pluginConnected(p: PluginInfo): Promise<"yes" | "no" | "limited"> {
  switch (p.auth) {
    case "github": return githubToken() ? "yes" : "limited";
    case "google": return googleTokenCached(p.scopes ?? []) ? "yes" : "no";
    case "microsoft": return (await msTokenSilent(p.scopes ?? []).catch(() => null)) ? "yes" : "no";
    case "notion": return notionSession() ? "yes" : "no";
    case "zotero": return zoteroAuth() ? "yes" : "no";
    default: return "yes";
  }
}

/** Who's connected, when we know (e.g. "@noahteitlebaum"). */
export function pluginAccount(p: PluginInfo): string | null {
  if (p.auth === "github") return githubAuth()?.login ? `@${githubAuth()!.login}` : null;
  if (p.auth === "notion") return notionSession()?.workspace ?? null;
  if (p.auth === "zotero") return zoteroAuth()?.username ?? null;
  return null;
}

/** Sign in for plugins whose sign-in is a pop-up (Google, Microsoft, Notion). Must run from a click.
 *  GitHub (device code) and Zotero (pasted key) have their own small forms (components/plugin-connect.tsx). */
export async function connectPopup(p: PluginInfo): Promise<void> {
  if (p.auth === "google") await googleToken(p.scopes ?? []);
  else if (p.auth === "microsoft") await msToken(p.scopes ?? [], p.name);
  else if (p.auth === "notion") await signInToNotion();
}

/** Forget the sign-in in this browser. Shared sign-ins (one Google / Microsoft account for several apps) go together. */
export async function disconnect(p: PluginInfo): Promise<void> {
  if (p.auth === "github") setGithubToken(null);
  else if (p.auth === "google") googleSignOut();
  else if (p.auth === "microsoft") await msSignOut();
  else if (p.auth === "notion") setNotionSession(null);
  else if (p.auth === "zotero") setZoteroAuth(null);
}

export const usesPopup = (p: PluginInfo) => p.auth === "google" || p.auth === "microsoft" || p.auth === "notion";
export const githubPrivateConfigured = githubSignInConfigured;
export const pluginInfo = (id: PluginId) => PLUGIN_BY_ID.get(id)!;
