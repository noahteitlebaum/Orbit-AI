// Models shown in each app's model menu, plus what the server needs to call and bill them.
// API ids and prices were checked against each provider's official docs on Oct 5 2026
// (platform.claude.com, developers.openai.com, ai.google.dev, docs.x.ai). Re-check before launch.
// Prices are US$ per 1M tokens, so cost in micros (millionths of $) = tokens × price.
export type ProviderId = "openai" | "anthropic" | "google" | "xai";

export interface ModelOption {
  id: string;          // our internal id (stable, used in stored messages)
  label: string;       // full name, e.g. "Claude Sonnet 5.5"
  short: string;       // name in the model menu button
  description: string; // one line under the name in the model menu
  provider: ProviderId;
  providerLabel: string;
  enabled: boolean;
  apiModel: string;    // the provider's model id
  inputPrice: number;  // $ / 1M input tokens
  outputPrice: number; // $ / 1M output tokens (includes reasoning tokens)
  contextTokens: number; // most history we send per request (kept below the model's window to cap cost)
  maxOutputTokens: number;
}

export const MODELS: ModelOption[] = [
  {
    id: "openai-default", label: "GPT-6.1 Sol", short: "Sol", description: "Smart flagship for everyday work",
    provider: "openai", providerLabel: "OpenAI", enabled: true,
    apiModel: "gpt-6.1-sol", inputPrice: 2, outputPrice: 10, contextTokens: 60_000, maxOutputTokens: 8_000,
  },
  {
    id: "openai-astra", label: "GPT-6 Astra", short: "Astra", description: "Most capable — slower and pricier",
    provider: "openai", providerLabel: "OpenAI", enabled: true,
    apiModel: "gpt-6-astra", inputPrice: 10, outputPrice: 50, contextTokens: 40_000, maxOutputTokens: 8_000,
  },
  {
    id: "openai-luna", label: "GPT-6 Luna", short: "Luna", description: "Fastest and cheapest",
    provider: "openai", providerLabel: "OpenAI", enabled: true,
    apiModel: "gpt-6-luna", inputPrice: 0.1, outputPrice: 0.5, contextTokens: 60_000, maxOutputTokens: 8_000,
  },

  {
    id: "anthropic-default", label: "Claude Sonnet 5.5", short: "Sonnet 5.5", description: "Best balance of speed and intelligence",
    provider: "anthropic", providerLabel: "Anthropic", enabled: true,
    apiModel: "claude-sonnet-5-5", inputPrice: 2, outputPrice: 10, contextTokens: 60_000, maxOutputTokens: 8_000,
  },
  {
    id: "anthropic-opus", label: "Claude Opus 5.5", short: "Opus 5.5", description: "Most capable for complex work",
    provider: "anthropic", providerLabel: "Anthropic", enabled: true,
    apiModel: "claude-opus-5-5", inputPrice: 4, outputPrice: 20, contextTokens: 60_000, maxOutputTokens: 8_000,
  },
  {
    id: "anthropic-haiku", label: "Claude Haiku 4.5", short: "Haiku 4.5", description: "Fastest for quick answers",
    provider: "anthropic", providerLabel: "Anthropic", enabled: true,
    apiModel: "claude-haiku-4-5-20251001", inputPrice: 1, outputPrice: 5, contextTokens: 60_000, maxOutputTokens: 8_000,
  },

  {
    // Google doubles Flash prices on Jan 1 2027 ($1.50 / $7.50) — update then.
    id: "google-default", label: "Gemini 3.8 Flash", short: "Flash", description: "Fast all-round help",
    provider: "google", providerLabel: "Google", enabled: true,
    apiModel: "gemini-3.8-flash", inputPrice: 0.75, outputPrice: 3.75, contextTokens: 60_000, maxOutputTokens: 8_000,
  },
  {
    // Prices for prompts ≤200k tokens (we never send more).
    id: "google-pro", label: "Gemini 3.1 Pro", short: "Pro", description: "Reasoning, math and code",
    provider: "google", providerLabel: "Google", enabled: true,
    apiModel: "gemini-3.1-pro-preview", inputPrice: 2, outputPrice: 12, contextTokens: 60_000, maxOutputTokens: 8_000,
  },

  {
    id: "xai-default", label: "Grok 4.7", short: "Grok 4.7", description: "xAI's flagship model",
    provider: "xai", providerLabel: "xAI", enabled: true,
    apiModel: "grok-4.7", inputPrice: 2, outputPrice: 6, contextTokens: 60_000, maxOutputTokens: 8_000,
  },
];

// Image generation, one model per app. pricePerImage = null means "not set up" (the app says so instead of guessing).
export interface ImageModel {
  provider: ProviderId;
  label: string;
  apiModel: string;
  pricePerImage: number | null; // US$
}

export const IMAGE_MODELS: Record<ProviderId, ImageModel | null> = {
  // OpenAI prices images by quality/size via a calculator — set pricePerImage from developers.openai.com/api/docs/pricing.
  openai: { provider: "openai", label: "GPT Image 2.5", apiModel: "gpt-image-2.5-flare", pricePerImage: null },
  anthropic: null, // Claude doesn't generate images.
  google: { provider: "google", label: "Gemini 3.1 Flash Image", apiModel: "gemini-3.1-flash-image", pricePerImage: 0.07 },
  xai: { provider: "xai", label: "Grok Imagine", apiModel: "grok-imagine-image-2.0", pricePerImage: 0.04 },
};

// Which apps can read PDF pages visually (scanned pages, diagrams): the PDF itself is sent to the model.
// xAI's chat API takes images but not PDFs, so Grok is told which pages it can't see.
export const PDF_INPUT: Record<ProviderId, boolean> = { openai: true, anthropic: true, google: true, xai: false };

// Folder access (browser folder picker + file tools). All four APIs support function calling; switch one off here if needed.
export const FOLDER_ACCESS: Record<ProviderId, boolean> = { openai: true, anthropic: true, google: true, xai: true };

export const DEFAULT_MODEL_ID = MODELS[0].id;
export const PROVIDERS: ProviderId[] = ["openai", "anthropic", "google", "xai"];

export function getModel(id: string | undefined): ModelOption | undefined {
  return MODELS.find((m) => m.id === id);
}

export function modelsFor(provider: ProviderId): ModelOption[] {
  return MODELS.filter((m) => m.enabled && m.provider === provider);
}

export function defaultModelFor(provider: ProviderId): string {
  return modelsFor(provider)[0]?.id ?? DEFAULT_MODEL_ID;
}

export function isProvider(v: unknown): v is ProviderId {
  return typeof v === "string" && (PROVIDERS as string[]).includes(v);
}
