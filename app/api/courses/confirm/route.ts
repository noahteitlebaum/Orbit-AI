import { dbError,isUuid,json,requireAppUser } from '@/lib/api';
import { validateDraft } from '@/lib/courses/parse';
export async function POST(request:Request){
 const auth=await requireAppUser();if('error'in auth)return auth.error;
 const body=await request.json().catch(()=>null);if(!isUuid(body?.fileId))return json({error:'bad_request'},400);
 const stored=await auth.supabase.from('syllabus_drafts').select('target_id').eq('file_id',body.fileId).eq('user_id',auth.user.id).maybeSingle();
 if(stored.error)return dbError(stored.error,'load_failed');if(!stored.data)return json({error:'not_found'},404);
 const previous=stored.data.target_id?await auth.supabase.from('files').select('id').eq('project_id',stored.data.target_id).eq('user_id',auth.user.id):null;
 if(previous?.error)return dbError(previous.error,'load_failed');
 const fileIds=[body.fileId,...(previous?.data??[]).map(f=>f.id)];
 const chunks=await auth.supabase.from('file_chunks').select('id').in('file_id',fileIds).eq('user_id',auth.user.id);
 if(chunks.error)return dbError(chunks.error,'load_failed');
 try{
  const draft=validateDraft(body.draft,new Set((chunks.data??[]).map(c=>c.id)));
  draft.items=draft.items.map(i=>({...i,id:i.id??crypto.randomUUID()}));
  const {data,error}=await auth.supabase.rpc('confirm_syllabus',{p_file:body.fileId,p_draft:draft});
  if(error)return dbError(error,'confirm_failed',409);return json({courseId:data});
 }catch{return json({error:'invalid_draft'},400);}
}
