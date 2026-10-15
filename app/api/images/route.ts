import { randomUUID } from "node:crypto";
import { IMAGE_MODELS, isProvider } from "@/config/models";
import { isUuid, json, requireAppUser } from "@/lib/api";
import { isProviderDisabled, overRateLimit, reserve, settle } from "@/lib/billing/budget";
import { ADAPTERS, apiKeyFor, liveFor } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/types";
import { createAdminClient } from "@/lib/supabase/admin";

// POST /api/images { provider, prompt, conversationId?, projectId? }
// Same safety steps as chat: auth → ownership → gates → reserve (flat price per image) → generate → store → settle.
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const { user, supabase } = auth;

  const body = (await request.json().catch(() => null)) as { provider?: unknown; prompt?: unknown; conversationId?: unknown; projectId?: unknown } | null;
  if (!body || !isProvider(body.provider)) return json({ error: "bad_request" }, 400);
  const provider = body.provider;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 4000) : "";
  if (!prompt) return json({ error: "empty_message" }, 400);
  const imageModel = IMAGE_MODELS[provider];
  if (!imageModel) return json({ error: "no_image_model" }, 400);
  const live = liveFor(provider);
  if (live && imageModel.pricePerImage == null) return json({ error: "not_configured" }, 503);

  // conversation
  let conversation: { id: string; title: string };
  if (isUuid(body.conversationId)) {
    const { data } = await supabase.from("conversations").select("id, title, provider").eq("id", body.conversationId).maybeSingle();
    if (!data) return json({ error: "not_found" }, 404);
    if (data.provider !== provider) return json({ error: "wrong_app" }, 400);
    conversation = data;
  } else {
    const { data, error } = await supabase
      .from("conversations")
      .insert({ user_id: user.id, provider, model_id: `${provider}-default`, title: prompt.slice(0, 60), project_id: isUuid(body.projectId) ? body.projectId : null })
      .select("id, title")
      .single();
    if (error || !data) return json({ error: "save_failed" }, 500);
    conversation = data;
  }

  const { data: userMsg } = await supabase
    .from("messages")
    .insert({ conversation_id: conversation.id, user_id: user.id, role: "user", content: prompt })
    .select("id")
    .single();
  await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversation.id);
  const base = { conversationId: conversation.id, title: conversation.title, userMessageId: userMsg?.id };

  // Demo mode: no provider call, no cost.
  if (!live) {
    const note = `(${imageModel.label} demo) An image of "${prompt.slice(0, 120)}" would appear here once LIVE_MODELS=on and the API key is set.`;
    const { data: reply } = await supabase
      .from("messages")
      .insert({ conversation_id: conversation.id, user_id: user.id, role: "assistant", content: note, model_id: `${provider}-image` })
      .select("id")
      .single();
    return json({ ...base, message: { id: reply?.id ?? randomUUID(), role: "assistant", kind: "text", content: note, modelId: `${provider}-image`, status: "complete" } });
  }

  const apiKey = apiKeyFor(provider);
  if (!apiKey) return json({ ...base, error: "not_configured" }, 503);
  if (await isProviderDisabled(provider)) return json({ ...base, error: "provider_disabled" }, 503);
  if (await overRateLimit(user.id)) return json({ ...base, error: "rate_limited" }, 429);

  const requestId = randomUUID();
  const price = Math.ceil(imageModel.pricePerImage! * 1_000_000);
  const r = await reserve(user.id, requestId, imageModel.apiModel, "image", price, {provider,operation:"image",unitCostUsdMicros:price,conversationId:conversation.id});
  if (!r.ok) {
    const code = r.reason === "global_stop" ? "paused" : r.reason === "budget" ? "budget" : "reserve_failed";
    return json({ ...base, error: code }, code === "budget" ? 402 : 503);
  }

  let generated: { mime: string; bytes: Uint8Array } | null = null;
  try {
    generated = await ADAPTERS[provider].generateImage!({ model: imageModel, prompt, apiKey, signal: AbortSignal.timeout(110_000) });
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError("unknown");
    // A rejected request (4xx/5xx before anything was made) isn't billed by the provider.
    await settle(requestId, err.started ? "uncertain" : "released", 0, undefined, err.code);
    return json({ ...base, error: err.code }, 502);
  }

  // Generated (and billed by the provider) from here on.
  await settle(requestId, "settled", price);
  const ext = generated.mime.includes("jpeg") ? "jpg" : generated.mime.includes("webp") ? "webp" : "png";
  const path = `${user.id}/${randomUUID()}.${ext}`;
  const { error: upErr } = await createAdminClient().storage.from("generated").upload(path, generated.bytes, { contentType: generated.mime });
  if (upErr) return json({ ...base, error: "save_failed" }, 500);

  const { data: reply } = await supabase
    .from("messages")
    .insert({ conversation_id: conversation.id, user_id: user.id, role: "assistant", kind: "image", image_path: path, content: prompt, model_id: `${provider}-image` })
    .select("id")
    .single();
  const { data: signed } = await supabase.storage.from("generated").createSignedUrl(path, 60 * 60);
  return json({ ...base, message: { id: reply?.id ?? randomUUID(), role: "assistant", kind: "image", content: prompt, imageUrl: signed?.signedUrl ?? null, modelId: `${provider}-image`, status: "complete" } });
}
