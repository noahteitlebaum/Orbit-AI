import { describe,expect,it } from "vitest";
import { buildEconomicContext,economicInputBudget,estimateTokens,costMicros,reservationMicros } from "./context";
import { selectRetrieval } from "./retrieval";
import { xaiBillableOutput } from "@/lib/providers/usage";
import { cadToUsd,usdToCad } from "@/config/economics";
import { relevantMemories } from "@/lib/profile/personal";
import type {ChatTurn} from "@/lib/providers/types";

describe('economic context and accounting',()=>{
 it('starts at 8k and expands for recent exchanges, capped independently of model window',()=>{
   const short:ChatTurn[]=[{role:'user',content:'Explain meiosis'}];
   expect(economicInputBudget(short,1500,60000)).toBe(8000);
   expect(economicInputBudget(short,1500,60000,true)).toBe(16000);
   expect(economicInputBudget([{role:'user',content:'x'.repeat(100000)}],1000,60000)).toBe(24000);
   expect(economicInputBudget(short,1500,5000)).toBe(5000);
 });
 it('keeps complete recent exchanges and newest question without a leading orphan assistant',()=>{
   const turns:ChatTurn[]=Array.from({length:21},(_,i)=>({role:i%2?'assistant':'user',content:`${i}:`+'x'.repeat(900)}));
   const ctx=buildEconomicContext(turns,3500);
   expect(ctx.turns[0].role).toBe('user');expect(ctx.turns.at(-1)).toBe(turns.at(-1));expect(ctx.dropped).toBe(true);
 });
 it('prices cache reads and writes separately; never adds reasoning to normalized output',()=>{
   const m={inputPrice:2,outputPrice:10,cachedInputPrice:0.1,cacheWritePrice:2.5};
   expect(costMicros(m,{input:1000,output:100,reasoning:50,cached:600,cacheWrite:100})).toBe(1910);
   expect(reservationMicros(m,1000,100)).toBeGreaterThan(costMicros(m,{input:1000,output:100,cacheWrite:1000}));
   expect(xaiBillableOutput(100,50,20,150)).toBe(50);
   expect(xaiBillableOutput(100,50,20,170)).toBe(70);
   expect(xaiBillableOutput(100,50,20)).toBe(70);
 });
 it('converts a CAD credit cap conservatively without assuming an FX quote',()=>{
   expect(cadToUsd(2500000,1.25)).toBe(2000000);expect(usdToCad(50000,1.25)).toBe(62500);
   expect(()=>cadToUsd(20,0)).toThrow('invalid_fx_rate');
 });
 it('retrieves a relevant older fact, excluding duplicates and weak matches within token budget',()=>{
   const r=selectRetrieval([
     {source_id:'old',source_kind:'message',content:'My lab uses 0.15 M saline.',similarity:0.9},
     {source_id:'recent',source_kind:'message',content:'already present',similarity:1},
     {source_id:'noise',source_kind:'memory',content:'irrelevant',similarity:0.1},
   ],new Set(['recent']));
   expect(r.count).toBe(1);expect(r.block).toContain('0.15 M');expect(estimateTokens(r.block)).toBeLessThan(1200);
 });
 it('bounds personal memory while preferring relevant facts',()=>{
   const mem=Array.from({length:100},(_,i)=>({id:String(i),content:i===99?'Uses SI units in physics':'Likes concise answers '+i,source:'student' as const,created_at:''}));
   const picked=relevantMemories(mem,'Use SI units for physics');
   expect(picked[0].id).toBe('99');expect(picked.length).toBeLessThanOrEqual(12);
 });
});
