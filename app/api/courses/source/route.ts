import {dbError,isUuid,json,requireAppUser} from '@/lib/api';
export async function GET(request:Request){
 const auth=await requireAppUser();if('error'in auth)return auth.error;const id=new URL(request.url).searchParams.get('id');if(!isUuid(id))return json({error:'bad_request'},400);
 const {data,error}=await auth.supabase.from('file_chunks').select('id,file_id,page,content').eq('id',id).eq('user_id',auth.user.id).maybeSingle();
 if(error)return dbError(error,'load_failed');if(!data)return json({error:'not_found'},404);return json({source:data});
}
