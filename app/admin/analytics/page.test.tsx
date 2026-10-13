import {readFileSync,readdirSync,writeFileSync} from "node:fs";
import {renderToStaticMarkup} from "react-dom/server";
import {beforeEach,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({admin:true}));
vi.mock("@/lib/analytics/admin",()=>({requireAnalyticsAdmin:async()=>state.admin?{user:{id:"synthetic"}}:{error:Response.json({error:"forbidden"},{status:403})}}));
vi.mock("next/navigation",()=>({notFound:()=>{throw new Error('not_found')}}));
vi.mock("@/lib/analytics/report",()=>({loadAnalyticsReport:async()=>({days:30,financial:{revenue_cad_micros:0,api_usd_micros:50000,api_cad_micros:62500,fees_cad_micros:0,costs_without_fx:0,legacy_cost_rows:0,uncertain_calls:1,reserved_usd_micros:0},product:{dau:3,wau:8,mau:12,messages:200,model_switches:20},context:{mean_input_tokens:6500,cache_read_ratio:0.2,usd_micros_per_100_calls:2500000},cohorts:[{cohort:'synthetic-7day',trial_days:7,enrolled:12,matured_trials:0}],models:[{provider:'openai',model_id:'openai-default',operation:'chat',calls:100,cost_usd_micros:50000}],features:[{feature:'quiz',users:5,uses:20}],users:[{user_id:'synthetic-user',api_usd_micros:50000,allowance_utilization:0.1,reserved_micros:0}]})}));
import Page from "./page";
beforeEach(()=>{state.admin=true});
it('renders financial, product, context and cohort data without inventing subscription revenue',async()=>{
 const markup=renderToStaticMarkup(await Page());
 expect(markup).toContain('Orbit analytics');expect(markup).toContain('Context performance');expect(markup).toContain('synthetic-7day');expect(markup).toContain('CAD 0.00');expect(markup).toContain('No data');
 if(process.env.VISUAL_QA==='on') {
   const css=readdirSync('.next/static/chunks').filter(f=>f.endsWith('.css')).map(f=>readFileSync('.next/static/chunks/'+f,'utf8')).join('\n');
   writeFileSync('/tmp/orbit_dashboard_fixture.html',`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body>${markup}</body></html>`);
 }
});
it('denies non-admins before rendering the report',async()=>{
 state.admin=false;await expect(Page()).rejects.toThrow('not_found');
});
