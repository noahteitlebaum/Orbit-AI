import { json } from "@/lib/api";
import { requireAnalyticsAdmin } from "@/lib/analytics/admin";
import { loadAnalyticsReport } from "@/lib/analytics/report";
export async function GET(request:Request) {
  const auth=await requireAnalyticsAdmin();
  if("error" in auth) return auth.error;
  const days=Number(new URL(request.url).searchParams.get("days")??30);
  if(!Number.isInteger(days)||days<1||days>90) return json({error:"bad_request"},400);
  try {return Response.json(await loadAnalyticsReport(days),{headers:{"Cache-Control":"private, no-store"}});}
  catch {return json({error:"analytics_unavailable",message:"Apply migrations 0009–0011 before opening analytics."},503);}
}
