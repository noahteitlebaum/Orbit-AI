import {beforeEach,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
const state=vi.hoisted(()=>({reserve:vi.fn(async()=>({ok:true})),settle:vi.fn(async()=>{}),writes:vi.fn(async()=>({error:null}))}));
vi.mock("@/lib/billing/budget",()=>({reserve:state.reserve,settle:state.settle,isProviderDisabled:async()=>false}));
import {retrieveRelevant} from "./retrieval";
const U='11111111-1111-4111-8111-111111111111',C='22222222-2222-4222-8222-222222222222';
function client(enabled=true){
 const query={select:()=>query,eq:()=>query,in:()=>query,maybeSingle:async()=>({data:{memory_enabled:enabled}}),
 then:(resolve:(value:unknown)=>unknown)=>Promise.resolve({data:[],error:null}).then(resolve),upsert:state.writes};
 return {from:()=>query,rpc:async()=>({data:[{source_id:'old',source_kind:'message',content:'0.15 M saline',similarity:0.9}],error:null})} as unknown as SupabaseClient;
}
const options=()=>({supabase:client(),userId:U,conversationId:C,enabled:true,query:'Which concentration?',sources:[{id:'old',kind:'message' as const,content:'0.15 M saline'}],memories:[],excluded:new Set<string>()});
beforeEach(()=>{vi.clearAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('never embeds or reserves without both feature flag and user opt-in',async()=>{
 const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
 expect(await retrieveRelevant(options())).toEqual({block:'',count:0});
 vi.stubEnv('SMART_MEMORY_ENABLED','on');
 expect(await retrieveRelevant({...options(),enabled:false})).toEqual({block:'',count:0});
 expect(await retrieveRelevant({...options(),supabase:client(false)})).toEqual({block:'',count:0});
 expect(state.reserve).not.toHaveBeenCalled();expect(fetchMock).not.toHaveBeenCalled();
});
it('reserves and records embedding expenses then retrieves only scoped sources',async()=>{
 vi.stubEnv('SMART_MEMORY_ENABLED','on');vi.stubEnv('OPENAI_API_KEY','synthetic-key');
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({usage:{prompt_tokens:100},data:[0,1].map(index=>({index,embedding:Array(1536).fill(0.1)}))})));
 const r=await retrieveRelevant(options());
 expect(r.count).toBe(1);expect(r.block).toContain('0.15 M');
 expect(state.reserve).toHaveBeenCalledWith(U,expect.any(String),'text-embedding-3-small','text',expect.any(Number),{provider:'openai',operation:'embedding',conversationId:C});
 expect(state.settle).toHaveBeenCalledWith(expect.any(String),'settled',2,{input:100,output:0,reasoning:0,cached:0});
});
it('leaves unknown embedding provider outcomes uncertain and falls back without breaking the chat',async()=>{
 vi.stubEnv('SMART_MEMORY_ENABLED','on');vi.stubEnv('OPENAI_API_KEY','synthetic-key');
 vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('timeout')}));
 expect(await retrieveRelevant(options())).toEqual({block:'',count:0});
 expect(state.settle).toHaveBeenCalledWith(expect.any(String),'uncertain',0,undefined,'embedding_failed');
});
