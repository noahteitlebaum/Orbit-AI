import {beforeEach,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({admin:false,load:vi.fn(async()=>({financial:{api_usd_micros:100}}))}));
vi.mock("@/lib/analytics/admin",()=>({requireAnalyticsAdmin:async()=>state.admin?{user:{id:"synthetic"}}:{error:Response.json({error:"forbidden"},{status:403})}}));
vi.mock("@/lib/analytics/report",()=>({loadAnalyticsReport:state.load}));
import {GET} from "./route";
beforeEach(()=>{state.admin=false;vi.clearAllMocks();});
it('never fetches aggregate data for a non-admin',async()=>{
 expect((await GET(new Request('http://x/api/admin/analytics'))).status).toBe(403);
 expect(state.load).not.toHaveBeenCalled();
});
it('validates scope and marks authorized financial reports as private/no-store',async()=>{
 state.admin=true;
 expect((await GET(new Request('http://x/api/admin/analytics?days=91'))).status).toBe(400);
 const res=await GET(new Request('http://x/api/admin/analytics?days=7'));
 expect(res.status).toBe(200);expect(res.headers.get('Cache-Control')).toBe('private, no-store');expect(state.load).toHaveBeenCalledWith(7);
});
