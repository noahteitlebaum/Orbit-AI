import {describe,it,expect} from 'vitest';
import {parseExtraction,validateDraft,validDate} from './parse';
const id='11111111-1111-4111-8111-111111111111';
const draft=()=>({name:'Synthetic course',term:'Fall 2026',instructor:'',schedule:'',officeHours:'',items:[{title:'Essay',kind:'assignment',due:null,weight:'20%',details:'Due during exam period',sourceId:id,status:'todo'}]});
describe('syllabus review validation',()=>{
 it('keeps unknown dates unknown and enforces provenance',()=>{expect(parseExtraction(JSON.stringify(draft()),[{id,content:'Essay 20%',page:2}]).items[0].due).toBeNull();expect(()=>parseExtraction(JSON.stringify(draft()),[])).toThrow('invalid_source');});
 it('rejects impossible dates and excessive structured data',()=>{expect(validDate('2026-02-30')).toBe(false);expect(validDate('2026-10-22')).toBe(true);const d=draft();expect(()=>validateDraft({...d,items:Array(81).fill(d.items[0])})).toThrow();});
 it('never accepts invented completed tasks or IDs from extraction',()=>{const d=draft();d.items[0].status='done';const out=parseExtraction(JSON.stringify(d),[{id,content:'Essay',page:2}]);expect(out.items[0].status).toBe('todo');expect(out.items[0].id).toBeUndefined();});
 it('permits manual items without invented sources',()=>{const d=draft();expect(validateDraft({...d,items:[{...d.items[0],sourceId:null}]}).items[0].sourceId).toBeNull();});
});
import {mergeRevision} from './parse';
it('merges revised syllabus proposals without losing completion or unmatched manual tasks',()=>{
 const original=validateDraft(draft());original.items[0]={...original.items[0],id,status:'done'};
 const incoming=validateDraft({...draft(),items:[{...draft().items[0],details:'Changed requirements',due:'2026-10-25'}]});
 const merged=mergeRevision(original,incoming);expect(merged.items[0]).toEqual(original.items[0]);
 original.items[0].status='doing';expect(mergeRevision(original,incoming).items[0]).toMatchObject({id,status:'doing',details:'Changed requirements'});
});
