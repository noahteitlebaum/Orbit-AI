import type { ProviderId } from "@/config/models";
import { anthropic } from "./anthropic";
import { google } from "./google";
import { openai } from "./openai";
import type { ProviderAdapter } from "./types";
import { xai } from "./xai";

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = { openai, anthropic, google, xai };

const KEY_ENV: Record<ProviderId, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
};

/** LIVE_MODELS=on → real provider calls (with budget checks). Anything else → mock replies, no cost. */
export function isLive(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LIVE_MODELS ?? "").trim().toLowerCase() === "on";
}

/**
 * Real calls for one app: LIVE_MODELS=on AND that provider's key is set. Apps without a key keep giving
 * clearly labelled demo replies (no cost), so one provider can go live before the others.
 */
export function liveFor(provider: ProviderId, env: Record<string, string | undefined> = process.env): boolean {
  return isLive(env) && apiKeyFor(provider, env) !== null;
}

export function liveProviders(env: Record<string, string | undefined> = process.env): ProviderId[] {
  return (Object.keys(KEY_ENV) as ProviderId[]).filter((p) => liveFor(p, env));
}

// Other names people commonly use for the same key.
const KEY_ALIASES: Partial<Record<ProviderId, string[]>> = { anthropic: ["CLAUDE_API_KEY"], google: ["GOOGLE_API_KEY"] };

/** The server-side API key for a provider, or null if it isn't set. Never send this to the client. */
export function apiKeyFor(provider: ProviderId, env: Record<string, string | undefined> = process.env): string | null {
  for (const name of [KEY_ENV[provider], ...(KEY_ALIASES[provider] ?? [])]) {
    const v = env[name]?.trim();
    if (v) return v;
  }
  return null;
}
