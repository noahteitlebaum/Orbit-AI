import {describe,it,expect} from 'vitest';
import {fakeSupabase} from '@/test/fake-supabase';
import {courseContext} from './context';
import {estimateTokens} from '@/lib/chat/context';
describe('course chat context',()=>{
 it('includes deadlines for planning without lexical overlap and preserves course preferences',async()=>{
  const f=fakeSupabase({projects:[{id:'c',user_id:'u',name:'Biology',instructions:'Use concise explanations',course_data:{officeHours:'Tuesday 2 pm',items:[{title:'Essay',kind:'assignment',details:'Research',due:'2026-10-22',status:'todo'}]}}]});
  const c=await courseContext(f.client as unknown as Parameters<typeof courseContext>[0],'u','c','What is due this week?');expect(c.block).toContain('2026-10-22');expect(c.block).toContain('Tuesday 2 pm');expect(c.block).toContain('Use concise explanations');expect(estimateTokens(c.block)).toBeLessThan(1700);
 });
 it('denies another owner before reading material',async()=>{const f=fakeSupabase({projects:[{id:'c',user_id:'v',name:'Private course'}]});await expect(courseContext(f.client as unknown as Parameters<typeof courseContext>[0],'u','c','Help')).rejects.toThrow('course_unavailable');});
});
