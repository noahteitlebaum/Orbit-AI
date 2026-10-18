import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks=vi.hoisted(()=>({claims:vi.fn(),refresh:false}));
vi.mock('@supabase/ssr',()=>({createServerClient:(_url:string,_key:string,options:{cookies:{setAll:(cookies:{name:string,value:string,options:object}[],headers:Record<string,string>)=>void}})=>({auth:{getClaims:async()=>{if(mocks.refresh)options.cookies.setAll([{name:'session',value:'refreshed',options:{httpOnly:true}}],{'Cache-Control':'private, no-store'});return mocks.claims();}}})}));
import { proxy } from './proxy';
describe('public landing and login session routing',()=>{
 beforeEach(()=>{vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://example.supabase.co');vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','test');mocks.refresh=false;mocks.claims.mockResolvedValue({data:{claims:null}});});
 afterEach(()=>vi.unstubAllEnvs());
 it.each(['/','/login','/reset','/auth/callback'])('keeps %s accessible signed out',async(path)=>{expect((await proxy(new NextRequest(`https://orbit.example${path}`))).headers.get('location')).toBeNull();});
 it('redirects signed-out protected pages to login',async()=>{expect((await proxy(new NextRequest('https://orbit.example/admin/analytics'))).headers.get('location')).toBe('https://orbit.example/login');});
 it('preserves refreshed session cookies on signed-in home',async()=>{mocks.refresh=true;mocks.claims.mockResolvedValue({data:{claims:{sub:'student'}}});const response=await proxy(new NextRequest('https://orbit.example/'));expect(response.headers.get('location')).toBeNull();expect(response.cookies.get('session')?.value).toBe('refreshed');expect(response.headers.get('cache-control')).toBe('private, no-store');});
 it('leaves API authentication to the route instead of returning login HTML',async()=>{expect((await proxy(new NextRequest('https://orbit.example/api/chat'))).headers.get('location')).toBeNull();});
});
