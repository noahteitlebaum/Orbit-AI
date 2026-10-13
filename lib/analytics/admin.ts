import { requireAppUser, json } from "@/lib/api";
export function isAnalyticsAdmin(email: string | undefined): boolean {
  if (!email) return false;
  const allowed = (process.env.ANALYTICS_ADMIN_EMAILS ?? "").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(email.toLowerCase());
}
export async function requireAnalyticsAdmin() {
  const auth = await requireAppUser();
  if ("error" in auth) return auth;
  if (!isAnalyticsAdmin(auth.user.email)) return {error:json({error:"forbidden"},403)};
  return auth;
}
