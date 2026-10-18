import { COURSES } from '@/config/courses';
import { getModel } from '@/config/models';
import { reserve, settle, isProviderDisabled, overRateLimit } from '@/lib/billing/budget';
import { estimateTokens, reservationMicros, costMicros } from '@/lib/chat/context';
import { ADAPTERS, apiKeyFor, isLive } from '@/lib/providers';
import { ProviderError, type Usage } from '@/lib/providers/types';
import { EXTRACTION_PROMPT, parseExtraction, type SourceChunk } from './parse';
export async function extractSyllabus(userId: string, chunks: SourceChunk[], signal: AbortSignal) {
  const model=getModel(COURSES.model), content=JSON.stringify(chunks);
  const input=estimateTokens(EXTRACTION_PROMPT)+estimateTokens(content)+16;
  if(input>COURSES.maxInputTokens) throw new Error('syllabus_too_large');
  if(!isLive()) throw new Error('extraction_not_enabled');
  if(!model?.enabled || !apiKeyFor(model.provider) || await isProviderDisabled(model.provider)) throw new Error('provider_unavailable');
  if(await overRateLimit(userId)) throw new Error('rate_limited');
  if(signal.aborted) throw new Error('cancelled');
  const id=crypto.randomUUID();
  const r=await reserve(userId,id,model.id,'text',reservationMicros(model,input,COURSES.maxOutput),{provider:model.provider,operation:'syllabus',inputEstimate:input});
  if(!r.ok) throw new Error(r.reason);
  let text='',usage:Usage|undefined,finish='unknown';
  try {
    for await(const event of ADAPTERS[model.provider].stream({model,system:EXTRACTION_PROMPT,history:[{role:'user',content}],maxOutput:COURSES.maxOutput,apiKey:apiKeyFor(model.provider)!,signal})) {
      if(event.delta)text+=event.delta;if(event.usage)usage=event.usage;if(event.finish)finish=event.finish;
    }
  } catch(e) {
    if(usage)await settle(id,'settled',costMicros(model,usage),usage,'syllabus_failed');
    else if(e instanceof ProviderError && !e.started && e.status && e.status>=400 && e.status<500 && e.status!==408) await settle(id,'released',0,undefined,e.code);
    else await settle(id,'uncertain',0,undefined,'syllabus_failed');
    throw new Error('extraction_failed');
  }
  if(usage)await settle(id,'settled',costMicros(model,usage),usage,undefined,{finishReason:finish});
  else await settle(id,'uncertain',0,undefined,'no_usage');
  if(finish!=='stop')throw new Error('extraction_incomplete');
  return parseExtraction(text,chunks);
}
