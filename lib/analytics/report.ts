import { createAdminClient } from "@/lib/supabase/admin";
export type Metric = number | string | null;
export type AnalyticsReport = { days:number; financial:Record<string,Metric>; product:Record<string,Metric>; context:Record<string,Metric>;
  cohorts:Record<string,Metric>[]; models:Record<string,Metric>[]; features:Record<string,Metric>[]; users:Record<string,Metric>[] };
export async function loadAnalyticsReport(days=30): Promise<AnalyticsReport> {
  const {data,error} = await createAdminClient().rpc("orbit_analytics_report",{p_days:Math.min(90,Math.max(1,Math.floor(days)))});
  if(error || !data) throw new Error("analytics_unavailable");
  return data as AnalyticsReport;
}
