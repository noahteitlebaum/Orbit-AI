import { dbError,isUuid,json,requireAppUser } from '@/lib/api';
import { validateDraft } from '@/lib/courses/parse';
export async function GET(_:Request,ctx:RouteContext<'/api/courses/[id]'>){
 const auth=await requireAppUser();if('error'in auth)return auth.error;const{id}=await ctx.params;if(!isUuid(id))return json({error:'bad_request'},400);
 const {supabase,user}=auth;
 const course=await supabase.from('projects').select('id').eq('id',id).eq('user_id',user.id).maybeSingle();
 if(course.error)return dbError(course.error,'load_failed');if(!course.data)return json({error:'not_found'},404);
 const [files,chats]=await Promise.all([supabase.from('files').select('id,name,status,project_id').eq('project_id',id).eq('user_id',user.id).order('created_at',{ascending:false}),supabase.from('conversations').select('id,title,provider,project_id,orbit_mode').eq('project_id',id).eq('user_id',user.id).order('updated_at',{ascending:false}).limit(100)]);
 if(files.error||chats.error)return dbError(files.error??chats.error,'load_failed');return json({files:files.data,chats:chats.data});
}
export async function PATCH(request:Request,ctx:RouteContext<'/api/courses/[id]'>){
 const auth=await requireAppUser();if('error'in auth)return auth.error;const{id}=await ctx.params;if(!isUuid(id))return json({error:'bad_request'},400);
 const body=await request.json().catch(()=>null);if(typeof body?.version!=='string')return json({error:'bad_request'},400);
 try{
  const draft=validateDraft(body.draft);
  const ids=draft.items.flatMap(i=>i.sourceId?[i.sourceId]:[]);
  if(ids.length){const files=await auth.supabase.from('files').select('id').eq('project_id',id).eq('user_id',auth.user.id);if(files.error)return dbError(files.error,'load_failed');const chunks=await auth.supabase.from('file_chunks').select('id').in('file_id',(files.data??[]).map(f=>f.id)).eq('user_id',auth.user.id).in('id',ids);if(chunks.error)return dbError(chunks.error,'load_failed');validateDraft(body.draft,new Set((chunks.data??[]).map(c=>c.id)));}
  draft.items=draft.items.map(i=>({...i,id:i.id??crypto.randomUUID()}));
  const {data,error}=await auth.supabase.from('projects').update({name:draft.name,course_data:draft,updated_at:new Date().toISOString()}).eq('id',id).eq('user_id',auth.user.id).eq('updated_at',body.version).select('id,name,instructions,course_data,syllabus_id,updated_at').maybeSingle();
  if(error)return dbError(error,'save_failed');if(!data)return json({error:'course_changed'},409);return json({course:data});
 }catch{return json({error:'invalid_draft'},400);}
}
