import {beforeEach,describe,expect,it,vi} from "vitest";
const state=vi.hoisted(()=>({insert:vi.fn(async()=>({error:null}))}));
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:()=>({from:()=>({insert:state.insert})})}));
import {trackEvent} from "./events";
import {isAnalyticsAdmin} from "./admin";
beforeEach(()=>{vi.clearAllMocks();vi.unstubAllEnvs();});
describe('analytics privacy and access',()=>{
 it('rejects content from arbitrary properties and records only allowed fields',async()=>{
  await trackEvent('synthetic','message_sent',{provider:'openai',modelId:'openai-default',...{content:'private chat',email:'secret@uwo.ca'}},undefined,'message:1');
  expect(state.insert).toHaveBeenCalledWith(expect.objectContaining({properties:{provider:'openai',modelId:'openai-default'}}));
 });
 it('staff allowlist denies by default and uses exact email matches',()=>{
   expect(isAnalyticsAdmin('admin@uwo.ca')).toBe(false);
   vi.stubEnv('ANALYTICS_ADMIN_EMAILS',' Admin@uwo.ca ');
   expect(isAnalyticsAdmin('admin@uwo.ca')).toBe(true);
   expect(isAnalyticsAdmin('xadmin@uwo.ca')).toBe(false);
 });
});
