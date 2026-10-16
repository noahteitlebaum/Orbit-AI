import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { fakeSupabase } from "@/test/fake-supabase";
import { PROVIDERS } from "@/config/models";
const s=vi.hoisted(()=>({fake:null as ReturnType<typeof fakeSupabase>|null,authError:null as Response|null,live:true,disabled:false,key:true,claimed:true,rpc:vi.fn(),call:vi.fn()}));
vi.mock("@/lib/api",async orig=>({...await orig<typeof import("@/lib/api")>(),requireAppUser:async()=>s.authError?{error:s.authError}:{user:{id:"u"},supabase:s.fake!.client}}));
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:()=>({rpc:s.rpc})}));
vi.mock("@/lib/providers",()=>({isLive:()=>s.live,apiKeyFor:()=>s.key?"synthetic-key":null}));
vi.mock("@/lib/billing/budget",()=>({isProviderDisabled:async()=>s.disabled,overRateLimit:async()=>false}));
vi.mock("@/lib/profile/personal",()=>({loadPersonal:async()=>({profile:null,memories:[]}),personalPrompt:()=>"",relevantMemories:()=>[],parseRemember:(text:string)=>({clean:text,saved:[]}),saveMemories:vi.fn()}));
vi.mock("@/lib/chat/summary",()=>({updateSummary:vi.fn()}));
vi.mock("@/lib/orbit/call",async orig=>({...await orig<typeof import("@/lib/orbit/call")>(),orbitCall:s.call}));
import { GET,POST } from "./route";
import { updateSummary } from "@/lib/chat/summary";
const req=(body:object)=>new Request("http://x/api/orbit",{method:"POST",body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("ORBIT_MODE_ENABLED","on");s.fake=fakeSupabase();s.authError=null;s.live=true;s.disabled=false;s.key=true;s.claimed=true;
 s.rpc.mockImplementation(async(name:string)=>({data:name==="claim_orbit_turn"?s.claimed:null,error:null}));
 s.call.mockImplementation(async o=>{
   if(o.operation==="orbit_vote"){const i=PROVIDERS.indexOf(o.model.provider);return {text:JSON.stringify({nominee:PROVIDERS[(i+1)%4],collaborate:false,specialist:null}),finish:"stop"};}
   o.delta?.("Synthetic final answer");return {text:"Synthetic final answer",finish:"stop"};
 });});
afterEach(()=>vi.unstubAllEnvs());
describe("Orbit endpoint",()=>{
 it("rechecks the lead's disable switch after voting before summarization",async()=>{
   const id=crypto.randomUUID();s.fake!.db.conversations.push({id,user_id:"u",orbit_mode:true,summary:null,summary_upto:null});
   for(let i=0;i<30;i++)s.fake!.db.messages.push({id:`old-${i}`,conversation_id:id,seq:i-30,role:i%2?"assistant":"user",content:"synthetic ".repeat(100),status:"complete",kind:"text"});
   let votes=0;
   s.call.mockImplementation(async o=>{const i=PROVIDERS.indexOf(o.model.provider);if(++votes===4)s.disabled=true;
     return {text:JSON.stringify({nominee:PROVIDERS[(i+1)%4],collaborate:false,specialist:null}),finish:"stop"};});
   const text=await(await POST(req({content:"A new question",conversationId:id}))).text();
   expect(text).toContain("orbit_provider_unavailable");expect(updateSummary).not.toHaveBeenCalled();expect(s.call).toHaveBeenCalledTimes(4);
 });
 it("requires app access before any other work",async()=>{
   s.authError=new Response(null,{status:403});expect((await POST(req({content:"question"}))).status).toBe(403);expect(s.rpc).not.toHaveBeenCalled();expect(s.call).not.toHaveBeenCalled();
 });
 it.each(["flag","key","disabled"])("blocks unavailable %s without voting",async reason=>{
   if(reason==="flag")vi.stubEnv("ORBIT_MODE_ENABLED","");if(reason==="key")s.key=false;if(reason==="disabled")s.disabled=true;
   expect((await POST(req({content:"question"}))).status).toBe(503);expect(s.call).not.toHaveBeenCalled();
 });
 it("enforces the user lease",async()=>{
   s.claimed=false;expect((await POST(req({content:"question"}))).status).toBe(409);expect(s.call).not.toHaveBeenCalled();
 });
 it("does not open a foreign or ordinary conversation",async()=>{
   const id=crypto.randomUUID();s.fake!.db.conversations.push({id,orbit_mode:false});expect((await POST(req({content:"question",conversationId:id}))).status).toBe(404);expect(s.call).not.toHaveBeenCalled();
 });
 it("makes exactly four votes and one answer for a solo turn, storing decision and author",async()=>{
   const res=await POST(req({content:"Explain a confidence interval"}));const text=await res.text();expect(text).toContain('"t":"done"');expect(s.call).toHaveBeenCalledTimes(5);
   const answer=s.fake!.db.messages.find(m=>m.role==="assistant")!;expect(answer).toMatchObject({status:"complete",content:"Synthetic final answer"});expect(answer.orbit_details).toHaveProperty("ballots");expect(answer.model_id).toBeTruthy();
   expect(s.rpc).toHaveBeenLastCalledWith("release_orbit_turn",expect.any(Object));
 });
 it("stops when a voter self-nominates; does not call an answer model",async()=>{
   s.call.mockImplementation(async o=>({text:JSON.stringify({nominee:o.model.provider,collaborate:false,specialist:null}),finish:"stop"}));
   const text=await(await POST(req({content:"question"}))).text();expect(text).toContain("orbit_vote_failed");expect(s.call).toHaveBeenCalledTimes(4);expect(s.fake!.db.messages.filter(m=>m.role==="assistant")).toHaveLength(0);
 });
 it("adds only one specialist when three ballots request collaboration",async()=>{
   s.call.mockImplementation(async o=>{
     if(o.operation==="orbit_vote"){const voter=o.model.provider;const nominee=voter==="anthropic"?"openai":"anthropic";const specialist=voter==="google"?"xai":"google";return {text:JSON.stringify({nominee,collaborate:true,specialist}),finish:"stop"};}
     o.delta?.("Final synthesis");return {text:"Independent specialist notes",finish:"stop"};
   });
   const text=await(await POST(req({content:"Analyze and check this argument"}))).text();expect(text).toContain('"t":"done"');expect(s.call.mock.calls.filter(([o])=>o.operation==="orbit_specialist")).toHaveLength(1);expect(s.call).toHaveBeenCalledTimes(6);
   expect(s.call.mock.calls.find(([o])=>o.operation==="orbit_answer")![0].system).toContain("Independent specialist notes");
 });
 it("clearly simulates demo routing without any paid model calls",async()=>{
   s.live=false;const text=await(await POST(req({content:"question"}))).text();expect(text).toContain('"demo":true');expect(text).toContain("simulated votes");expect(s.call).not.toHaveBeenCalled();
 });
 it("returns only Orbit messages through its read endpoint",async()=>{
   expect((await GET(new Request(`http://x/api/orbit?conversationId=${crypto.randomUUID()}`))).status).toBe(404);
 });
});
