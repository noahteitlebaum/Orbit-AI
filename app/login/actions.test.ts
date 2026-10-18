import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({signin:vi.fn(),signout:vi.fn(),verify:vi.fn(),resend:vi.fn()}));
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>({auth:{signInWithPassword:mocks.signin,signOut:mocks.signout}})}));
vi.mock('@/lib/auth/flows',()=>({verifyEmailCode:mocks.verify,resendSignupCode:mocks.resend}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error(`redirect:${path}`);}}));
import { signInAction, signOut } from './actions';
const previous={step:'credentials' as const,email:''};
function form(values:Record<string,string>){const data=new FormData();for(const [k,v] of Object.entries(values))data.set(k,v);return data;}
describe('existing password login',()=>{
 beforeEach(()=>{vi.resetAllMocks();mocks.signin.mockResolvedValue({data:{user:{email:'student@uwo.ca'}},error:null});});
 it('normalizes credentials and redirects successful sign-in to home',async()=>{await expect(signInAction(previous,form({email:' Student@UWO.ca ',password:'test-password'}))).rejects.toThrow('redirect:/');expect(mocks.signin).toHaveBeenCalledWith({email:'student@uwo.ca',password:'test-password'});});
 it('rejects lookalike domains before authentication',async()=>{expect((await signInAction(previous,form({email:'student@uwo.ca.evil.com',password:'test'}))).error).toContain('@uwo.ca');expect(mocks.signin).not.toHaveBeenCalled();});
 it('keeps invalid credentials on the login form',async()=>{mocks.signin.mockResolvedValue({data:{user:null},error:{code:'invalid_credentials'}});expect(await signInAction(previous,form({email:'student@uwo.ca',password:'wrong'}))).toMatchObject({step:'credentials',error:expect.any(String)});});
 it('offers verification for an unconfirmed account',async()=>{mocks.signin.mockResolvedValue({data:{user:null},error:{code:'email_not_confirmed'}});expect(await signInAction(previous,form({email:'student@uwo.ca',password:'test'}))).toMatchObject({step:'verify'});expect(mocks.resend).toHaveBeenCalledWith('student@uwo.ca');});
 it('redirects after successful email verification',async()=>{await expect(signInAction(previous,form({intent:'verify',email:'student@uwo.ca',code:'123456'}))).rejects.toThrow('redirect:/');expect(mocks.verify).toHaveBeenCalledWith('student@uwo.ca','123456');});
 it('signs out an unexpected returned non-Western identity',async()=>{mocks.signin.mockResolvedValue({data:{user:{email:'other@example.com'}},error:null});expect((await signInAction(previous,form({email:'student@uwo.ca',password:'test'}))).error).toContain('@uwo.ca');expect(mocks.signout).toHaveBeenCalled();});
 it('signs out and returns to login',async()=>{await expect(signOut()).rejects.toThrow('redirect:/login');expect(mocks.signout).toHaveBeenCalled();});
});
