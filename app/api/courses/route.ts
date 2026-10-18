import {validateDraft} from '@/lib/courses/parse';
import { dbError,json,requireAppUser } from '@/lib/api';
export async function GET(){
 const auth=await requireAppUser();if('error'in auth)return auth.error;
 const {data,error}=await auth.supabase.from('projects').select('id,name,instructions,course_data,syllabus_id,updated_at').eq('user_id',auth.user.id).order('name');
 if(error)return dbError(error,'load_failed');return json({courses:data??[]});
}

export async function POST(request:Request){
 const auth=await requireAppUser();if('error'in auth)return auth.error;
 const body=await request.json().catch(()=>null);
 try{const draft=validateDraft(body?.draft,new Set());draft.items=draft.items.map(i=>({...i,id:crypto.randomUUID()}));
 const {data,error}=await auth.supabase.from('projects').insert({user_id:auth.user.id,provider:null,name:draft.name,instructions:'',course_data:draft}).select('id').single();
 if(error)return dbError(error,'save_failed');return json({courseId:data.id});
 }catch{return json({error:'invalid_draft'},400);}
}
