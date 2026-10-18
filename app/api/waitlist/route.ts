import {createHmac} from 'node:crypto';
import {createAdminClient} from '@/lib/supabase/admin';
import {waitlistInstitution} from '@/config/institutions';
export async function POST(request:Request){
 const origin=request.headers.get('origin');if(!origin||origin!==new URL(request.url).origin)return Response.json({error:'Please submit from the Orbit website.'},{status:403});
 if(!request.headers.get('content-type')?.includes('application/json'))return Response.json({error:'Invalid request.'},{status:400});
 const reader=request.body?.getReader();if(!reader)return Response.json({error:'Invalid request.'},{status:400});
 let raw='',bytes=0;const decoder=new TextDecoder();
 while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>3000){await reader.cancel();return Response.json({error:'Request too large.'},{status:413});}raw+=decoder.decode(next.value,{stream:true});}raw+=decoder.decode();
 let body;try{body=JSON.parse(raw);}catch{return Response.json({error:'Invalid request.'},{status:400});}
 if(!body||typeof body!=='object')return Response.json({error:'Invalid request.'},{status:400});
 if(body.website)return Response.json({ok:true}); // honeypot; never disclose whether an email is already registered
 const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
 const name=waitlistInstitution(body.institution,body.school);
 if(email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!name||body.consent!==true)return Response.json({error:'Choose your school, enter a valid email, and confirm the waitlist notice.'},{status:400});
 const secret=process.env.SUPABASE_SECRET_KEY;
 if(!secret||!process.env.NEXT_PUBLIC_SUPABASE_URL)return Response.json({error:'Waitlist registration is not configured yet. Please check back soon.'},{status:503});
 // Store a keyed digest, never the visitor’s raw IP. Hosting must overwrite the forwarded header.
 const ip=request.headers.get('x-vercel-forwarded-for')??request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()??'unknown';
 const bucket=createHmac('sha256',secret).update(ip).digest('hex');
 try{const{data,error}=await createAdminClient().rpc('join_waitlist',{p_email:email,p_institution:name,p_bucket:bucket});
  if(error)return Response.json({error:'Waitlist registration is temporarily unavailable. Please try later.'},{status:503});
  if(!data)return Response.json({error:'Too many attempts. Please try again in an hour.'},{status:429});
  return Response.json({ok:true});
 }catch{return Response.json({error:'Waitlist registration is temporarily unavailable. Please try later.'},{status:503});}
}
