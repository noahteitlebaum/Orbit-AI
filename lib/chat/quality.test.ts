import {describe,expect,it} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {PDFDocument} from "pdf-lib";
import {fakeSupabase} from "@/test/fake-supabase";
import {gatherMaterial,namedFiles,pickVisualPages} from "./material";
import {systemPrompt} from "./context";
const CHAT='synthetic-chat';
type FileRow=Parameters<typeof pickVisualPages>[0][number];
const file=(id:string,name:string,over:Record<string,unknown>={})=>({id,name,user_id:'synthetic',kind:'document',status:'ready',char_count:20000,page_count:30,project_id:null,conversation_id:CHAT,storage_path:'synthetic/'+name,mime:'application/pdf',visual_pages:[],...over});
describe('source selection regressions',()=>{
 it('reserves the visual budget for a named page ahead of unrelated scanned attachments',()=>{
  const unrelated=file('old','Other.pdf',{status:'needs_ocr',visual_pages:Array.from({length:20},(_,i)=>i+1)}) as FileRow;
  const target=file('target','Lecture3.pdf',{status:'needs_ocr',visual_pages:[12]}) as FileRow;
  const selected=pickVisualPages([unrelated,target],[],[],{conversationId:CHAT,newAttachmentIds:['old'],referencedFileIds:['target'],requestedPages:[12]});
  expect(selected.map(s=>({id:s.file.id,pages:s.pages}))).toEqual([{id:'target',pages:[12]}]);
 });
 it('does not mistake page 12 for Lecture 12 when the student asked about Lecture 3',()=>{
  const names=[{name:'Lecture3.pdf'},{name:'Lecture12.pdf'}];
  expect(namedFiles('Explain page 12 of lecture 3',names)).toEqual([names[0]]);
 });
 it('keeps the requested passage ahead of old attachments that could consume the whole source budget',async()=>{
  const f=fakeSupabase({files:[file('old','OldAssignment.pdf'),file('target','Lecture3.pdf',{project_id:'course',conversation_id:null})],file_chunks:[
    {file_id:'old',page:1,chunk_index:0,content:'Unrelated earlier assignment. '+'x'.repeat(32000)},
    {file_id:'target',page:12,chunk_index:11,content:'Independent assortment concerns segregation of different chromosome pairs.'},
  ]});
  const m=await gatherMaterial(f.client as unknown as SupabaseClient,{conversationId:CHAT,projectId:'course',question:'Explain page 12 of lecture 3',newAttachmentIds:[],pdfInput:true});
  expect(m.block).toContain('Independent assortment');expect(m.sources.map(s=>s.fileId)).toEqual(['target']);
 });
 it('selects a named scanned page beyond the default first-eight-page selection',async()=>{
  const f=fakeSupabase({files:[file('scan','Lecture3.pdf',{status:'needs_ocr',char_count:0,visual_pages:Array.from({length:20},(_,i)=>i+1)})]});
  const pdf=await PDFDocument.create();for(let i=0;i<20;i++)pdf.addPage([200,200]);
  f.storage['synthetic/Lecture3.pdf']={bytes:await pdf.save(),type:'application/pdf'};
  const m=await gatherMaterial(f.client as unknown as SupabaseClient,{conversationId:CHAT,projectId:null,question:'Explain page 12 of lecture 3',newAttachmentIds:[],pdfInput:true});
  expect(m.sources.map(s=>s.page)).toEqual([12]);expect(m.documents[0].name).toContain('pages 12');
 });
 it('keeps the referenced lecture/page for a short follow-up',async()=>{
  const f=fakeSupabase({files:[file('target','Lecture3.pdf')],file_chunks:[{file_id:'target',page:12,chunk_index:11,content:'Alleles segregate during gamete formation.'}]});
  const m=await gatherMaterial(f.client as unknown as SupabaseClient,{conversationId:CHAT,projectId:null,question:'Why is that?',previousQuestion:'Explain page 12 of lecture 3',newAttachmentIds:[],pdfInput:true});
  expect(m.sources.map(s=>s.page)).toEqual([12]);
 });
 it('discloses a missing requested page without silently substituting the opening page',async()=>{
  const f=fakeSupabase({files:[file('target','Lecture3.pdf')],file_chunks:[{file_id:'target',page:1,chunk_index:0,content:'Lecture overview'}]});
  const m=await gatherMaterial(f.client as unknown as SupabaseClient,{conversationId:CHAT,projectId:null,question:'Explain page 12 of lecture 3',newAttachmentIds:['target'],pdfInput:true});
  expect(m.sources).toEqual([]);expect(m.notes.join(' ')).toContain('requested page 12 could not be found');
 });
});
describe('shared student response contract',()=>{
 it('includes units/checks, corrections and untrusted-source boundaries while preserving explicit study modes',()=>{
  const p=systemPrompt({modelLabel:'Synthetic model',mode:'hints',summary:'old fact',courseOnly:true,material:'[S1] sample notes'});
  expect(p).toContain('final value with units');expect(p).toContain('latest user correction');expect(p).toContain('reference data');
  expect(p).toContain('HINTS ONLY');expect(p).toContain('answer ONLY from these passages');
 });
});
