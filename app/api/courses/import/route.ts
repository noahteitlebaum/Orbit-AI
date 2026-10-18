import { createAdminClient } from "@/lib/supabase/admin";
import { COURSES } from '@/config/courses';
import { dbError,isUuid,json,requireAppUser } from '@/lib/api';
import { extractSyllabus } from '@/lib/courses/extract';
export const maxDuration=120;
export async function POST(request:Request){
 const auth=await requireAppUser();if('error'in auth)return auth.error;
 const body=await request.json().catch(()=>null);if(!isUuid(body?.fileId))return json({error:'bad_request'},400);
 const {supabase,user}=auth;
 if(body.courseId!==undefined&&!isUuid(body.courseId))return json({error:'bad_request'},400);
 const target=body.courseId?await supabase.from('projects').select('id,updated_at').eq('id',body.courseId).eq('user_id',user.id).maybeSingle():null;
 if(target?.error)return dbError(target.error,'load_failed');if(target&&!target.data)return json({error:'not_found'},404);
 if(target?.data && target.data.updated_at!==body.version)return json({error:'course_changed'},409);
 const f=await supabase.from('files').select('id,status,visual_pages,project_id,conversation_id').eq('id',body.fileId).eq('user_id',user.id).maybeSingle();
 if(f.error)return dbError(f.error,'load_failed');if(!f.data)return json({error:'not_found'},404);
 const cached=await supabase.from('syllabus_drafts').select('draft,course_id,target_id').eq('file_id',body.fileId).eq('user_id',user.id).maybeSingle();
 if(cached.error)return dbError(cached.error,'load_failed');if(cached.data){if((cached.data.target_id??null)!==(body.courseId??null))return json({error:'draft_target_changed'},409);return json({draft:cached.data.draft,courseId:cached.data.course_id});}
 if(f.data.project_id||f.data.conversation_id)return json({error:'file_already_attached'},409);
 if(f.data.status!=='ready'||f.data.visual_pages?.length)return json({error:'text_syllabus_required'},422);
 const chunks=await supabase.from('file_chunks').select('id,content,page').eq('file_id',body.fileId).eq('user_id',user.id).order('chunk_index').limit(COURSES.maxChunks+1);
 if(chunks.error)return dbError(chunks.error,'load_failed');if(!chunks.data?.length)return json({error:'text_syllabus_required'},422);
 if(chunks.data.length>COURSES.maxChunks)return json({error:'syllabus_too_large'},413);
 const admin=createAdminClient(),claimId=crypto.randomUUID();
 const claim=await admin.rpc('claim_syllabus',{p_file:body.fileId,p_user:user.id,p_request:claimId});
 if(claim.error)return dbError(claim.error,'claim_failed');if(!claim.data)return json({error:'extraction_busy'},409);
 try{
  // Recheck after acquiring the lease: another request may have completed during the initial reads.
  const completed=await supabase.from('syllabus_drafts').select('draft,course_id,target_id').eq('file_id',body.fileId).eq('user_id',user.id).maybeSingle();
  if(completed.error)return dbError(completed.error,'load_failed');
  if(completed.data){if((completed.data.target_id??null)!==(body.courseId??null))return json({error:'draft_target_changed'},409);return json({draft:completed.data.draft,courseId:completed.data.course_id});}
  const draft=await extractSyllabus(user.id,chunks.data,AbortSignal.any([request.signal,AbortSignal.timeout(COURSES.timeoutMs)]));
  const saved=await supabase.from('syllabus_drafts').insert({file_id:body.fileId,user_id:user.id,draft,target_id:body.courseId??null,base_version:target?.data?.updated_at??null});
  if(saved.error)return dbError(saved.error,'save_failed');return json({draft});
 }catch(e){const code=e instanceof Error?e.message:'';const allowed=['syllabus_too_large','extraction_not_enabled','provider_unavailable','rate_limited','budget','global_stop','trial_expired','fx_not_configured','extraction_incomplete','invalid_draft','invalid_source'];return json({error:allowed.includes(code)?code:'extraction_failed'},422);}finally{await admin.rpc('release_syllabus',{p_file:body.fileId,p_request:claimId});}
}
