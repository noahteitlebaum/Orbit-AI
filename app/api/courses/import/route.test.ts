import {beforeEach,it,expect,vi} from 'vitest';
import {fakeSupabase} from '@/test/fake-supabase';
const s=vi.hoisted(()=>({fake:null as ReturnType<typeof import('@/test/fake-supabase').fakeSupabase>|null,extract:vi.fn(),locked:false,denied:false}));
vi.mock('@/lib/api',async original=>({...await original<typeof import('@/lib/api')>(),requireAppUser:async()=>s.denied?{error:Response.json({error:'waitlisted'},{status:403})}:{user:{id:'u'},supabase:s.fake!.client}}));
vi.mock('@/lib/courses/extract',()=>({extractSyllabus:s.extract}));
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>({rpc:async(name:string)=>{if(name==='claim_syllabus'){if(s.locked)return{data:false};s.locked=true;return{data:true};}s.locked=false;return{data:null};}})}));
import {POST} from './route';
const id='11111111-1111-4111-8111-111111111111';
const req=()=>new Request('http://localhost/api/courses/import',{method:'POST',body:JSON.stringify({fileId:id})});
beforeEach(()=>{vi.clearAllMocks();s.locked=false;s.denied=false;s.fake=fakeSupabase({files:[{id,user_id:'u',status:'ready',visual_pages:[]}],file_chunks:[{id:'chunk',file_id:id,user_id:'u',content:'Synthetic syllabus'}]});s.extract.mockResolvedValue({name:'Synthetic',items:[]});});
it('guards waitlist and ownership before spending',async()=>{s.denied=true;expect((await POST(req())).status).toBe(403);s.denied=false;s.fake!.db.files[0].user_id='v';expect((await POST(req())).status).toBe(404);expect(s.extract).not.toHaveBeenCalled();});
it('claims the file before extraction and reuses a saved draft without a new charge',async()=>{expect((await POST(req())).status).toBe(200);expect((await POST(req())).status).toBe(200);expect(s.extract).toHaveBeenCalledTimes(1);});
it('blocks a concurrent import before it spends',async()=>{let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});s.extract.mockImplementation(async()=>{await gate;return{name:'Synthetic',items:[]};});const first=POST(req());for(let i=0;i<20&&!s.locked;i++)await Promise.resolve();expect(s.locked).toBe(true);expect((await POST(req())).status).toBe(409);release();expect((await first).status).toBe(200);expect(s.extract).toHaveBeenCalledTimes(1);});
it('rejects unreadable pages without attempting partial extraction',async()=>{s.fake!.db.files[0].visual_pages=[2];expect((await POST(req())).status).toBe(422);expect(s.extract).not.toHaveBeenCalled();});
it('rejects stale course snapshots before extraction can overwrite completed work',async()=>{
 const courseId='22222222-2222-4222-8222-222222222222';s.fake!.db.projects.push({id:courseId,user_id:'u',updated_at:'2026-10-17T12:00:00Z'});
 const r=await POST(new Request('http://localhost/api/courses/import',{method:'POST',body:JSON.stringify({fileId:id,courseId,version:'2026-10-17T11:00:00Z'})}));
 expect(r.status).toBe(409);expect(s.extract).not.toHaveBeenCalled();
});
