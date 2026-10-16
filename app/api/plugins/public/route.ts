import { json, requireAppUser } from "@/lib/api";
import { isPublicTool, PublicToolError, runPublicTool, serverPluginsReady } from "@/lib/plugins/public";

// GET → { ready: ["wolfram", …] } plugins whose server key is set (so the Plugins page can say "not set up").
export async function GET() {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  return json({ ready: serverPluginsReady() });
}

// POST /api/plugins/public { tool, args } → { output } | { error }
// Runs a no-sign-in research plugin (Wikipedia, arXiv, Semantic Scholar, Crossref) for the student's browser.
// Only fixed hosts; the model supplies search words, titles and DOIs. Signed-in students only.
export async function POST(request: Request) {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  const body = (await request.json().catch(() => ({}))) as { tool?: unknown; args?: unknown };
  if (!isPublicTool(body.tool) || !body.args || typeof body.args !== "object" || JSON.stringify(body.args).length > 2_000) return json({ error: "bad_request" }, 400);
  try {
    return json({ output: await runPublicTool(body.tool, body.args as Record<string, unknown>) });
  } catch (e) {
    return json({ error: e instanceof PublicToolError ? e.message : "The service didn't respond. Try again." }, 502);
  }
}
