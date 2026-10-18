import {beforeEach,describe,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({reserve:vi.fn(),settle:vi.fn(),stream:vi.fn(),live:true,disabled:false,limited:false}));
vi.mock('@/lib/billing/budget',()=>({reserve:state.reserve,settle:state.settle,isProviderDisabled:async()=>state.disabled,overRateLimit:async()=>state.limited}));
vi.mock('@/lib/providers',()=>({isLive:()=>state.live,apiKeyFor:()=> 'synthetic',ADAPTERS:{openai:{stream:state.stream}}}));
import {extractSyllabus} from './extract';
const id='11111111-1111-4111-8111-111111111111',chunks=[{id,content:'Synthetic syllabus',page:1}];
beforeEach(()=>{vi.clearAllMocks();state.live=true;state.disabled=false;state.limited=false;state.reserve.mockResolvedValue({ok:true});state.stream.mockImplementation(async function*(){yield{delta:JSON.stringify({name:'Synthetic course',term:'',instructor:'',schedule:'',officeHours:'',items:[]})};yield{usage:{input:100,output:50,reasoning:0,cached:0}};yield{finish:'stop'};});});
describe('budgeted syllabus extraction',()=>{
 it('reserves before dispatch and bills an explicit operation',async()=>{await extractSyllabus('u',chunks,new AbortController().signal);expect(state.reserve.mock.calls[0][5].operation).toBe('syllabus');expect(state.reserve.mock.invocationCallOrder[0]).toBeLessThan(state.stream.mock.invocationCallOrder[0]);expect(state.settle.mock.calls[0][1]).toBe('settled');});
 it('never calls a provider without a budget reservation',async()=>{state.reserve.mockResolvedValue({ok:false,reason:'budget'});await expect(extractSyllabus('u',chunks,new AbortController().signal)).rejects.toThrow('budget');expect(state.stream).not.toHaveBeenCalled();});
 it('rejects over-limit syllabi without truncation or spending',async()=>{await expect(extractSyllabus('u',[{...chunks[0],content:'long '.repeat(20000)}],new AbortController().signal)).rejects.toThrow('syllabus_too_large');expect(state.reserve).not.toHaveBeenCalled();});
 it('keeps unknown dispatched costs reserved and rejects incomplete JSON',async()=>{state.stream.mockImplementation(async function*(){yield{delta:'{}'};});await expect(extractSyllabus('u',chunks,new AbortController().signal)).rejects.toThrow('extraction_incomplete');expect(state.settle.mock.calls[0][1]).toBe('uncertain');});
 it('does not simulate a real syllabus in demo mode',async()=>{state.live=false;await expect(extractSyllabus('u',chunks,new AbortController().signal)).rejects.toThrow('extraction_not_enabled');expect(state.reserve).not.toHaveBeenCalled();});
});
