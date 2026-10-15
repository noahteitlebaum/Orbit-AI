import { notFound } from "next/navigation";
import { requireAnalyticsAdmin } from "@/lib/analytics/admin";
import { loadAnalyticsReport, type Metric } from "@/lib/analytics/report";
export const dynamic = "force-dynamic";
const number=(v:Metric|undefined)=>v==null?"No data":Number(v).toLocaleString("en-CA",{maximumFractionDigits:2});
const money=(v:Metric|undefined,currency="USD")=>v==null?"No data":`${currency} ${(Number(v)/1e6).toFixed(2)}`;
const percent=(v:Metric|undefined)=>v==null?"No data":`${(Number(v)*100).toFixed(1)}%`;
function Panel({title,items}:{title:string;items:[string,string][]}) {
  return <section className="rounded-2xl border border-line bg-surface-100 p-5"><h2 className="mb-4 text-xl font-semibold">{title}</h2>
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">{items.map(([label,value])=><div key={label}><dt className="text-sm text-ink-muted">{label}</dt><dd className="text-lg font-medium tabular-nums">{value}</dd></div>)}</dl></section>;
}
function Table({title,rows,columns}:{title:string;rows:Record<string,Metric>[];columns:[string,string,(v:Metric)=>string][]}) {
  return <section className="overflow-x-auto rounded-2xl border border-line bg-surface-100 p-5"><h2 className="mb-4 text-xl font-semibold">{title}</h2>
    {!rows.length?<p className="text-ink-muted">No data yet.</p>:<table className="w-full text-left text-sm"><thead><tr>{columns.map(([key,label])=><th key={key} className="p-2 text-ink-muted">{label}</th>)}</tr></thead>
      <tbody>{rows.map((row,i)=><tr key={i} className="border-t border-line">{columns.map(([key,,format])=><td key={key} className="p-2 tabular-nums">{format(row[key])}</td>)}</tr>)}</tbody></table>}</section>;
}
export default async function AnalyticsPage() {
  const auth=await requireAnalyticsAdmin(); if("error" in auth) notFound();
  const report=await loadAnalyticsReport().catch(()=>null);
  if(!report) return <main className="p-8 text-ink">Analytics unavailable. Apply migrations 0009–0011 and check the server configuration.</main>;
  const f=report.financial,p=report.product,c=report.context;
  const completeFx=Number(f.costs_without_fx)===0 && Number(f.legacy_cost_rows)===0 && Number(f.uncertain_calls)===0 && Number(f.reserved_usd_micros)===0;
  const contribution=completeFx && Number(f.revenue_cad_micros)>0?Number(f.revenue_cad_micros)-Number(f.fees_cad_micros)-Number(f.api_cad_micros):null;
  const text=(v:Metric)=>v==null?"No data":String(v);
  return <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 text-ink"><h1 className="text-3xl font-semibold">Orbit analytics</h1>
    <p className="text-ink-muted">Last {report.days} days · Live usage only in engagement metrics. Provider costs are calculated from reported usage and versioned rates, pending invoice reconciliation. Payments remain disabled.</p>
    <div className="grid gap-6 lg:grid-cols-3">
    <Panel title="Financial" items={[["Net revenue",money(f.revenue_cad_micros,"CAD")],["Recorded API cost",money(f.api_usd_micros)],["API cost with known FX",money(f.api_cad_micros,"CAD")],
      ["Contribution after API and payment fees",money(contribution,"CAD")],["Contribution %",contribution==null?"No data":percent(contribution/Number(f.revenue_cad_micros))],
      ["Mean API cost per spending user",money(f.mean_user_cost_usd_micros)],["User spending p50 / p95",`${money(f.user_spend_p50_usd_micros)} / ${money(f.user_spend_p95_usd_micros)}`],
      ["Uncertain budget charges",money(f.uncertain_charges_usd_micros)],["Held reservations",money(f.reserved_usd_micros)],["Rows missing FX / legacy rows",`${number(f.costs_without_fx)} / ${number(f.legacy_cost_rows)}`]]}/>
    <Panel title="Product" items={[["DAU / WAU / MAU",`${number(p.dau)} / ${number(p.wau)} / ${number(p.mau)}`],["Messages",number(p.messages)],["Messages per active user",number(p.messages_per_active_user)],
      ["Messages per active conversation",number(p.messages_per_active_conversation)],["Model switches",number(p.model_switches)],["Allowance exhaustion events",number(p.allowance_exhaustions)],["Files uploaded",number(p.file_uploads)]]}/>
    <Panel title="Context performance" items={[["Mean input tokens",number(c.mean_input_tokens)],["Cache read share",percent(c.cache_read_ratio)],["Cost per 100 model calls",money(c.usd_micros_per_100_calls)],
      ["Summary / embedding cost",`${money(c.summary_usd_micros)} / ${money(c.embedding_usd_micros)}`],["Memory overhead share",percent(c.memory_cost_ratio)],
      ["Mean request latency (ms)",number(c.mean_latency_ms)],["Trimmed / retrieval calls",`${number(c.trimmed_calls)} / ${number(c.retrieval_used_calls)}`],["Provider errors",number(c.errors)]]}/>
    </div>
    <Table title="Trial cohorts (all time)" rows={report.cohorts} columns={[["cohort","Cohort",text],["trial_days","Days",number],["enrolled","Enrolled",number],["matured_trials","Matured",number],["trial_conversion_rate","Conversion",percent],["week2_retention","Week 2 retention",percent],["trial_cost_usd_micros","API trial cost",money],["trial_cost_per_conversion_usd_micros","Trial cost / conversion",money]]}/>
    <Table title="Cost by provider, model and operation" rows={report.models} columns={[["provider","Provider",text],["model_id","Model",text],["operation","Operation",text],["calls","Calls",number],["cost_usd_micros","Recorded cost",money],["unknown_cost_calls","Unknown cost calls",number]]}/>
    <Table title="Feature adoption" rows={report.features} columns={[["feature","Feature",text],["users","Users",number],["uses","Uses",number]]}/>
    <Table title="User spending (top 200, IDs only)" rows={report.users} columns={[["user_id","User ID",text],["api_usd_micros","API cost",money],["allowance_utilization","Allowance charged",percent],["reserved_micros","Reserved USD",money]]}/>
    <p className="text-sm text-ink-muted">Contribution excludes hosting, retrieval/database compute, support, refunds outside this window and acquisition costs. Retrieval usage measures inclusion, not answer quality. Compare identical synthetic benchmarks before claiming quality or cost savings.</p>
  </main>;
}
