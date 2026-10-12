import { json, requireAppUser } from "@/lib/api";
import { getUsage, recentAnswerCosts } from "@/lib/billing/budget";
import { isLive, liveProviders } from "@/lib/providers";

// GET /api/usage → { live, allowance, spent, reserved, typical } in micros (millionths of $).
// typical = this student's average cost per answer by model (for "about N more answers").
export async function GET() {
  const auth = await requireAppUser();
  if ("error" in auth) return auth.error;
  if (!isLive()) return json({ live: false, liveProviders: [], allowance: 0, spent: 0, reserved: 0 });
  const [usage, typical] = await Promise.all([getUsage(auth.user.id).catch(() => null), recentAnswerCosts(auth.user.id).catch(() => ({}))]);
  if (!usage) return json({ error: "load_failed" }, 500);
  return json({ live: true, liveProviders: liveProviders(), ...usage, typical });
}
