import { describe,expect,it } from "vitest";
import { MODELS } from "@/config/models";
import { buildContext,buildEconomicContext,economicInputBudget,estimateTokens,costMicros } from "@/lib/chat/context";
import { batches,transcriptLine } from "@/lib/chat/summary";
import { CONTEXT } from "@/config/context";
import type {ChatTurn} from "@/lib/providers/types";

// Deterministic synthetic workload, never student content. Estimates payload costs only, not live answer quality.
export const questions=[
 'Explain independent assortment and show how to distinguish it from segregation in a dihybrid cross.',
 'For my synthetic physics lab, use g=9.81 m/s^2 and a 0.15 M saline solution. Keep those fixed for later follow-ups.',
 'Compare the assumptions behind a paired t-test, an independent t-test and a repeated measures design.',
 'Help me interpret why increasing osmolarity changes red blood cell geometry and membrane energy.',
 'Draft a concise study outline linking free energy, enzyme kinetics and regulation of metabolic pathways.',
];
const explanation='A university-level worked explanation should identify the assumptions, define quantities, apply the relevant relation step by step, check units, then interpret the result and describe what additional evidence would change the conclusion. ';
describe('synthetic 100-interaction context benchmark',()=>{
 it('compares identical histories with baseline 60k and economic context including summary overhead',()=>{
  const model=MODELS.find(m=>m.id==='openai-default')!;
  const helper=MODELS.find(m=>m.id==='openai-luna')!;
  const history:ChatTurn[]=[];
  let baselineInput=0,optimizedInput=0,summaryCost=0,summaryCalls=0,checkpoint=-1;
  const fixed=1200,summaryTokens=500,output=700;
  for(let i=0;i<100;i++) {
   history.push({role:'user',content:questions[i%questions.length]+' '+explanation.repeat(3)});
   const baseline=buildContext(history,model.contextTokens-fixed-CONTEXT.summaryTokens);
   baselineInput+=fixed+baseline.tokens;
   const target=economicInputBudget(history,fixed+CONTEXT.summaryTokens+CONTEXT.retrievalTokens,model.contextTokens-model.maxOutputTokens);
   const ctx=buildEconomicContext(history,target-fixed-CONTEXT.summaryTokens-CONTEXT.retrievalTokens);
   optimizedInput+=fixed+ctx.tokens+(ctx.dropped?summaryTokens:0);
   expect(fixed+ctx.tokens+(ctx.dropped?summaryTokens:0)).toBeLessThanOrEqual(target);
   expect(ctx.turns.at(-1)?.content).toBe(history.at(-1)?.content);
   expect(ctx.turns.filter(t=>t.role==='assistant').length).toBeGreaterThanOrEqual(Math.min(i,5));
   const dropped=history.slice(0,history.length-ctx.turns.length).map((t,seq)=>({...t,seq})).filter(t=>t.seq>checkpoint);
   const batch=batches(dropped)[0];
   if(batch) {
    summaryCalls++;
    summaryCost+=costMicros(helper,{input:estimateTokens(batch.map(transcriptLine).join('\n\n'))+summaryTokens+250,output:summaryTokens});
    checkpoint=batch.at(-1)!.seq;
   }
   history.push({role:'assistant',content:explanation.repeat(9)});
  }
  const baselineCost=costMicros(model,{input:baselineInput,output:100*output});
  const optimizedCost=costMicros(model,{input:optimizedInput,output:100*output})+summaryCost;
  expect(optimizedCost).toBeLessThan(baselineCost);
  console.log(JSON.stringify({benchmark:'synthetic-estimate-only',interactions:100,baselineInput,optimizedInput,summaryCalls,
    baselineUsd:baselineCost/1e6,optimizedUsd:optimizedCost/1e6,summaryUsd:summaryCost/1e6,savingFraction:1-optimizedCost/baselineCost}));
 });
});
