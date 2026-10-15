import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const U="11111111-1111-4111-8111-111111111111", V="22222222-2222-4222-8222-222222222222", C="33333333-3333-4333-8333-333333333333";
let db:PGlite;
beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto,vector}});
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create schema storage;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
 create table storage.buckets(id text primary key,name text,public boolean);
 create table storage.objects(bucket_id text,name text);
 alter table storage.objects enable row level security;
 create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;`);
 for(const file of readdirSync('supabase/migrations').sort()) await db.exec(readFileSync(`supabase/migrations/${file}`,'utf8'));
 await db.exec(`grant usage on schema public,auth,extensions to authenticated;
 grant select,insert,update,delete on all tables in schema public to authenticated;
 grant usage,select on all sequences in schema public to authenticated;
 insert into auth.users values('${U}','synthetic1@uwo.ca',now()),('${V}','synthetic2@uwo.ca',now());
 insert into public.conversations(id,user_id,provider,model_id) values('${C}','${U}','openai','openai-default');`);
},30_000);
afterAll(async()=>{await db?.close();});
async function reserve(id:string,bound:number=1000000){
 return (await db.query<{r:{ok:boolean;reason?:string}}>(`select public.reserve_budget_v2($1,$2,'openai-default','text',$3,$4::jsonb,'{}') as r`,[U,id,bound,JSON.stringify({provider:'openai',operation:'chat',conversationId:C})])).rows[0].r;
}
describe('financial SQL and RLS',()=>{
 it('requires configured FX and creates CAD-capped, time-limited trial once',async()=>{
   expect(await reserve('fx-missing')).toMatchObject({ok:false,reason:'fx_not_configured'});
   await db.exec(`insert into public.settings values('usd_cad_rate','1.25');`);
   expect(await reserve('r1')).toMatchObject({ok:true});
   const b=(await db.query<{allowance_micros:number;allowance_cad_micros:number}>(`select * from public.budgets where user_id=$1`,[U])).rows[0];
   expect(Number(b.allowance_micros)).toBe(2_000_000); expect(Number(b.allowance_cad_micros)).toBe(2_500_000);
   expect(await reserve('r1')).toMatchObject({ok:false,reason:'duplicate'});
   expect(await reserve('over',1_500_000)).toMatchObject({ok:false,reason:'budget'});
 });
 it('settles only once and distinguishes unknown provider cost from a charged reservation',async()=>{
   await db.exec(`select public.settle_budget_v2('r1','uncertain',0); select public.settle_budget_v2('r1','settled',100);`);
   const l=(await db.query<{actual_micros:number;actual_usd_micros:number|null}>(`select * from public.ledger where request_id='r1'`)).rows[0];
   expect(Number(l.actual_micros)).toBe(1_000_000);expect(l.actual_usd_micros).toBeNull();
   expect(await reserve('r2',500_000)).toMatchObject({ok:true});
   await db.exec(`select public.settle_budget_v2('r2','settled',50000,1000,100,20,200,null,100); select public.settle_budget_v2('r2','settled',999999);`);
   const b=(await db.query<{spent_micros:number;reserved_micros:number}>(`select * from public.budgets where user_id=$1`,[U])).rows[0];
   expect(Number(b.spent_micros)).toBe(1_050_000);expect(Number(b.reserved_micros)).toBe(0);
 });
 it('blocks expired trials even when balance remains',async()=>{
   await db.exec(`update public.budgets set expires_at=now()-interval '1 day' where user_id='${U}'`);
   expect(await reserve('expired',1)).toMatchObject({ok:false,reason:'trial_expired'});
 });
 it('returns admin aggregates with uncertain costs visible and no private content',async()=>{
   const r=(await db.query<{r:Record<string,unknown>}>(`select public.orbit_analytics_report(30) as r`)).rows[0].r;
   expect(r).toHaveProperty('cohorts');expect(r).toHaveProperty('product');expect(r).toHaveProperty('context');
   expect(r.financial).toMatchObject({uncertain_calls:1,api_usd_micros:50000,api_cad_micros:62500});
   expect(JSON.stringify(r)).not.toContain('content');
 });
 it('students cannot call budget or aggregate RPCs',async()=>{
   await db.exec(`set role authenticated; select set_config('app.user_id','${V}',false);`);
   await expect(db.exec(`select public.orbit_analytics_report(30)`)).rejects.toThrow(/permission denied/);
   await expect(db.exec(`select public.reserve_budget_v2('${V}','attack','x','text',1)`)).rejects.toThrow(/permission denied/);
   expect((await db.query('select * from public.ledger')).rows).toHaveLength(0);
   await db.exec('reset role');
 });
 it('semantic retrieval isolates users and purges vectors when memory is disabled or deleted',async()=>{
   const body='Synthetic student prefers SI units.';
   const hash=createHash('sha256').update(body).digest('hex');
   const m='44444444-4444-4444-8444-444444444444';
   const vec=JSON.stringify(Array.from({length:1536},(_,i)=>i===0?1:0));
   await db.exec(`insert into public.profiles(user_id,memory_enabled) values('${U}',true),('${V}',true);
     insert into public.memories(id,user_id,content) values('${m}','${U}','${body}');`);
   await db.query(`insert into public.context_embeddings(user_id,source_kind,source_id,memory_id,content_hash,embedding) values($1,'memory',$2,$2,$3,$4)`,[U,m,hash,vec]);
   await db.exec(`set role authenticated; select set_config('app.user_id','${V}',false);`);
   expect((await db.query(`select * from public.retrieve_context($1,$2)`,[vec,C])).rows).toHaveLength(0);
   await db.exec(`select set_config('app.user_id','${U}',false);`);
   expect((await db.query(`select * from public.retrieve_context($1,$2)`,[vec,C])).rows).toHaveLength(1);
   await db.exec(`update public.profiles set memory_enabled=false where user_id='${U}'; reset role;`);
   expect((await db.query('select * from public.context_embeddings')).rows).toHaveLength(0);
   await db.query(`insert into public.context_embeddings(user_id,source_kind,source_id,memory_id,content_hash,embedding) values($1,'memory',$2,$2,$3,$4)`,[U,m,hash,vec]);
   await db.exec(`delete from public.memories where id='${m}'`);
   expect((await db.query('select * from public.context_embeddings')).rows).toHaveLength(0);
 });
});


it("atomically blocks AI-memory inserts after opt-out while allowing manual notes", async () => {
  const W="55555555-5555-4555-8555-555555555555";
  await db.exec(`insert into auth.users values('${W}','synthetic3@uwo.ca',now());
    insert into public.profiles(user_id,memory_enabled) values('${W}',true);
    set role authenticated; select set_config('app.user_id','${W}',false);`);
  try {
    const insert=async(source:string,content:string)=>(await db.query(`insert into public.memories(user_id,source,content) values($1,$2,$3) returning id`,[W,source,content])).rows;
    expect(await insert('ai','Enabled memory')).toHaveLength(1);
    await db.exec(`update public.profiles set memory_enabled=false where user_id='${W}'`);
    expect(await insert('ai','Late streamed memory')).toHaveLength(0);
    expect(await insert('student','Manual note')).toHaveLength(1);
    expect((await db.query(`select * from public.memories where user_id=$1 and content='Late streamed memory'`,[W])).rows).toHaveLength(0);
    await db.exec(`update public.profiles set memory_enabled=true where user_id='${W}'`);
    expect(await insert('ai','Enabled again')).toHaveLength(1);
    await expect(db.query(`insert into public.memories(user_id,source,content,conversation_id) values($1,'ai','Foreign chat',$2)`,[W,C])).rejects.toThrow(/invalid memory conversation/);
    await db.exec(`delete from public.profiles where user_id='${W}'`);
    expect(await insert('ai','No profile')).toHaveLength(0);
    await expect(db.exec(`insert into public.memories(user_id,source,content) values('${V}','ai','Cross user')`)).rejects.toThrow(/row-level security/);
  } finally { await db.exec('reset role'); }
});
