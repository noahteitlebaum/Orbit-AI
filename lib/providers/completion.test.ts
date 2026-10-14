import {afterEach,describe,expect,it,vi} from "vitest";
import {openai} from "./openai";import {anthropic} from "./anthropic";import {google} from "./google";import {xai} from "./xai";
import type {ProviderAdapter,StreamArgs,StreamEvent} from "./types";
import {MODELS} from "@/config/models";
const args:StreamArgs={model:MODELS[0],system:'synthetic',history:[{role:'user',content:'hello'}],maxOutput:100,apiKey:'synthetic',signal:new AbortController().signal};
function response(events:object[]) {return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})}
async function run(adapter:ProviderAdapter,events:object[]){vi.stubGlobal('fetch',vi.fn(async()=>response(events)));const out:StreamEvent[]=[];for await(const e of adapter.stream(args))out.push(e);return out;}
afterEach(()=>vi.unstubAllGlobals());
describe('provider completion states',()=>{
 it('OpenAI preserves usage when output ends during reasoning',async()=>{
  const out=await run(openai,[{type:'response.incomplete',response:{incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:10,output_tokens:100,output_tokens_details:{reasoning_tokens:100}}}}]);
  expect(out).toContainEqual({finish:'length'});expect(out.find(e=>e.usage)?.usage?.output).toBe(100);
 });
 it('Claude distinguishes output limit from normal completion',async()=>{
  const out=await run(anthropic,[{type:'message_start',message:{usage:{input_tokens:10}}},{type:'message_delta',delta:{stop_reason:'max_tokens'},usage:{output_tokens:100}},{type:'message_stop'}]);
  expect(out).toContainEqual({finish:'length'});
 });
 it('Gemini detects MAX_TOKENS while retaining billable thinking',async()=>{
  const out=await run(google,[{candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'partial'}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,thoughtsTokenCount:95}}]);
  expect(out).toContainEqual({finish:'length'});expect(out.find(e=>e.usage)?.usage?.output).toBe(100);
 });
 it('Grok identifies a content filter rather than reporting a complete answer',async()=>{
  const out=await run(xai,[{choices:[{finish_reason:'content_filter'}],usage:{prompt_tokens:10,completion_tokens:0,total_tokens:10}}]);
  expect(out).toContainEqual({finish:'blocked'});
 });
 it.each([openai,anthropic,google,xai])('$id rejects a stream closed without a terminal event',async adapter=>{
  await expect(run(adapter,[])).rejects.toMatchObject({code:'incomplete_stream',started:true});
 });
});
