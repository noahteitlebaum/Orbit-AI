"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PROVIDERS, getModel, type ProviderId } from "@/config/models";
import { ORBIT } from "@/config/orbit";
import { THEMES } from "@/config/themes";
import { ProviderLogo } from "@/components/provider-logo";
import { Wordmark, OrbitBackdrop } from "@/components/brand";
import { Markdown } from "@/components/markdown";
import { hideRememberMarkers } from "@/lib/profile/personal";
import type { Decision } from "@/lib/orbit/voting";

type Message = { id: string; role: "user" | "assistant"; content: string; status?: string; model_id?: string; orbit_details?: Decision };
type Chat = { id: string; title: string };
const PHASES: Record<string,string> = {voting:"Four AIs are voting…",summarizing:"Updating conversation context…",collaborating:"A specialist is contributing…",answering:"The lead is answering…"};
const ERRORS: Record<string,string> = {
  orbit_not_enabled:"Orbit mode is in preview. The team needs to enable it before live use.",
  orbit_provider_unavailable:"Orbit needs all four providers enabled and configured. No partial vote was started.",
  orbit_vote_failed:"The four-model vote could not be completed. No lead was substituted. Completed routing calls may still use allowance.",
  orbit_busy:"Another Orbit turn is running on your account. Wait for it to finish.",
  orbit_call_failed:"A provider call failed. Any partial answer is saved. You can send a follow-up to try again.",
  orbit_incomplete_response:"The model did not finish. Any partial answer is saved; check it before using it.",
  budget:"Your remaining allowance could not cover the next step. Earlier routing or specialist calls may already have used allowance.",
  paused:"Orbit has been paused by the team.",trial_expired:"Your trial has ended.",fx_not_configured:"Usage billing needs configuration by the team.",
  rate_limited:"Please wait a minute before starting another turn.",context_too_large:"This request is too large for Orbit's context limit. Split it into smaller parts.",
  orbit_helper_limit:"This request exceeds Orbit's routing and collaboration allowance. Try a smaller task.",
  db_setup:"Orbit's database update has not been applied. Contact the team.",
  save_failed:"The answer could not be fully saved. Refresh to check your saved chat before continuing.",
};

function Routing({ decision }: { decision: Decision }) {
  return <details className="mb-4 rounded-2xl border border-line bg-surface-100 p-3 text-xs text-ink-muted">
    <summary className="cursor-pointer leading-5">{decision.demo ? "Simulated routing · " : ""}Lead: {getModel(decision.leadModelId)?.label ?? decision.leadModelId}
      {decision.specialist ? ` · Specialist: ${getModel(decision.specialistModelId??"")?.label ?? decision.specialistModelId}` : " · Solo answer"}</summary>
    <ul className="mt-3 grid gap-2 sm:grid-cols-2">{decision.ballots.map(b=><li key={b.voter} className="flex items-center gap-2"><ProviderLogo provider={b.voter} size={16}/>{THEMES[b.voter].appName} → {THEMES[b.nominee].appName}{b.collaborate?" · requests specialist":""}</li>)}</ul>
    <p className="mt-3">{decision.tied ? "Tied vote: a stable tie-break selected the lead. " : ""}No self-votes. Collaboration needs three votes. Selection is a recommendation, not a guarantee of correctness.</p>
  </details>;
}

export function OrbitChat({ onSelectProvider }: { onSelectProvider: (provider: ProviderId) => void }) {
  const [chats,setChats]=useState<Chat[]>([]), [active,setActive]=useState<string|null>(null);
  const [messages,setMessages]=useState<Message[]>([]), [input,setInput]=useState("");
  const [busy,setBusy]=useState(false), [loading,setLoading]=useState(false), [phase,setPhase]=useState(""), [error,setError]=useState("");
  const [decision,setDecision]=useState<Decision|null>(null), [dropped,setDropped]=useState(false), [sidebar,setSidebar]=useState(false);
  const [remaining,setRemaining]=useState<number|null>(null);
  const controller=useRef<AbortController|null>(null), bottom=useRef<HTMLDivElement>(null), view=useRef(0);
  const refresh=useCallback(async()=>{
    const [list,usage]=await Promise.all([fetch("/api/conversations?provider=orbit"),fetch("/api/usage")]);
    if(list.ok) setChats((await list.json()).conversations??[]);
    if(usage.ok){const u=await usage.json();if(u.live)setRemaining(u.allowance-u.spent-u.reserved);}
  },[]);
  // Loads remote data; state updates happen after the fetch responses.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{refresh().catch(()=>setError("Could not load Orbit chats."));return()=>controller.current?.abort();},[refresh]);
  useEffect(()=>{bottom.current?.scrollIntoView({behavior:"smooth"});},[messages,phase]);
  async function openChat(id:string) {
    const token=++view.current;setLoading(true);setSidebar(false);setError("");
    try {
      const res=await fetch(`/api/orbit?conversationId=${id}`);if(!res.ok)throw new Error();
      const data=await res.json();if(token!==view.current)return;
      setActive(id);setMessages(data.messages);setDropped(data.olderMessages);setDecision(null);
    } catch {if(token===view.current)setError("Could not open this chat. Try again.");}
    finally{if(token===view.current)setLoading(false);}
  }
  function newChat(){view.current++;setLoading(false);setActive(null);setMessages([]);setDecision(null);setDropped(false);setError("");setSidebar(false);}
  async function deleteChat() {
    if(!active||!window.confirm("Delete this Orbit conversation and its saved history?"))return;
    setLoading(true);
    try{const res=await fetch(`/api/conversations/${active}`,{method:"DELETE"});if(!res.ok)throw new Error();newChat();await refresh();}
    catch{setError("Could not delete this chat. Try again.");}finally{setLoading(false);}
  }
  async function send() {
    const content=input.trim();if(!content||busy||loading)return;
    setBusy(true);setError("");setInput("");setDecision(null);setPhase("voting");
    const userId=crypto.randomUUID(),localReply=crypto.randomUUID();let terminal=false,accepted=false;
    setMessages(prev=>[...prev,{id:userId,role:"user",content},{id:localReply,role:"assistant",content:"",status:"streaming"}]);
    const abort=new AbortController();controller.current=abort;
    const patch=(change:Partial<Message>)=>setMessages(prev=>prev.map(m=>m.id===localReply?{...m,...change}:m));
    try {
      const res=await fetch("/api/orbit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content,...(active?{conversationId:active}:{})}),signal:abort.signal});
      if(!res.ok){const d=await res.json();throw new Error(ERRORS[d.error]??"Orbit could not start this turn.");}
      if(!res.body)throw new Error("The response connection could not be opened.");
      const reader=res.body.getReader(),decoder=new TextDecoder();let buffer="",text="";
      const event=(line:string)=>{
        const ev=JSON.parse(line);
        if(ev.t==="meta"){accepted=true;setActive(ev.conversationId);setDropped(ev.dropped);}
        else if(ev.t==="stage")setPhase(ev.stage);
        else if(ev.t==="decision"){setDecision(ev.decision);patch({orbit_details:ev.decision});}
        else if(ev.t==="reply")patch({model_id:ev.modelId});
        else if(ev.t==="delta"){text+=ev.v;patch({content:text});}
        else if(ev.t==="done"){terminal=true;patch({content:ev.content,status:"complete"});}
        else if(ev.t==="error"){terminal=true;patch({status:"partial"});setError(ERRORS[ev.code]??"Orbit could not finish this turn. Completed calls may have used allowance.");}
      };
      while(true){const {value,done}=await reader.read();if(done){buffer+=decoder.decode();break;}buffer+=decoder.decode(value,{stream:true});const lines=buffer.split("\n");buffer=lines.pop()??"";for(const line of lines)if(line.trim())event(line);}
      if(buffer.trim())event(buffer);
      if(!terminal)throw new Error("The connection ended before Orbit finished. Refresh to check the saved answer before continuing.");
    } catch(e) {
      if(!accepted){setMessages(prev=>prev.filter(m=>m.id!==userId&&m.id!==localReply));setInput(content);}
      else patch({status:"partial"});
      setError(abort.signal.aborted?"Stopped locally. A dispatched answer may still finish and use allowance. Reopen the chat to check the saved result.":(e as Error).message);
    }
    finally{controller.current=null;setBusy(false);setPhase("");await refresh().catch(()=>{});}
  }
  return <div className="flex h-dvh bg-surface-000 font-ui text-ink">
    <nav aria-label="AI apps" className="hidden w-[76px] shrink-0 flex-col items-center gap-3 border-r border-line bg-surface-100 py-4 md:flex">
      <Wordmark className="mb-3 [&>span]:hidden" markSize={32}/>
      <button aria-pressed className="grid gap-1 rounded-2xl bg-surface-300 p-2 text-xs font-semibold"><span className="text-brand">◎</span>Orbit</button>
      {PROVIDERS.map(p=><button key={p} disabled={busy} onClick={()=>onSelectProvider(p)} className="flex flex-col items-center gap-1 rounded-xl p-2 text-[11px] text-ink-muted hover:bg-surface-200 disabled:opacity-50"><ProviderLogo provider={p} size={24}/>{THEMES[p].appName}</button>)}
    </nav>
    {sidebar&&<button aria-label="Close chats" onClick={()=>setSidebar(false)} className="fixed inset-0 z-20 bg-surface-000/80 md:hidden"/>}
    <aside className={`${sidebar?"flex":"hidden"} fixed inset-y-0 left-0 z-30 w-64 shrink-0 flex-col border-r border-line bg-surface-100 p-4 md:static md:flex`}>
      <Wordmark/><p className="mt-1 text-xs text-ink-muted">Orbit mode · Preview</p>
      <button onClick={newChat} disabled={busy} className="my-5 rounded-xl border border-line px-4 py-2 text-left hover:bg-surface-200 disabled:opacity-50">＋ New Orbit chat</button>
      <div className="flex-1 space-y-1 overflow-y-auto">{chats.map(c=><button key={c.id} onClick={()=>openChat(c.id)} disabled={busy||loading} className={`w-full truncate rounded-xl px-3 py-2 text-left text-sm hover:bg-surface-200 ${active===c.id?"bg-surface-300":""}`}>{c.title}</button>)}{!chats.length&&<p className="px-3 text-sm text-ink-subtle">Your Orbit conversations appear here.</p>}</div>
      <p className="mt-4 text-xs leading-5 text-ink-muted">Your question and selected context go to all four providers. Routing and collaboration count toward your allowance.</p>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-3 sm:px-6">
        <button className="rounded-lg p-2 md:hidden" aria-label="Open chats" onClick={()=>setSidebar(true)}>☰</button>
        <span className="font-semibold">Orbit mode</span><span className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-muted">Preview</span>
        <div className="ml-auto flex items-center gap-2">{remaining!==null&&<span className="text-xs text-ink-muted">US${(Math.max(0,remaining)/1e6).toFixed(2)} left</span>}{active&&<button disabled={busy||loading} onClick={deleteChat} className="rounded-lg border border-line px-2 py-1 text-xs disabled:opacity-50">Delete chat</button>}</div>
        <div className="flex w-full items-center justify-end gap-3 md:hidden" aria-label="Other AI apps">{PROVIDERS.map(p=><button key={p} disabled={busy} onClick={()=>onSelectProvider(p)} aria-label={THEMES[p].appName} className="rounded-lg p-1 disabled:opacity-50"><ProviderLogo provider={p} size={18}/></button>)}</div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto max-w-3xl">
          {!messages.length&&!loading&&<div className="py-8 text-center sm:py-16"><OrbitBackdrop className="mx-auto mb-6 grid h-44 w-44 place-items-center"><span className="text-5xl text-brand">◎</span></OrbitBackdrop><h1 className="text-3xl font-semibold tracking-tight">Four perspectives. One conversation.</h1><p className="mx-auto mt-4 max-w-lg text-sm leading-6 text-ink-muted">ChatGPT, Claude, Gemini and Grok vote on a lead. When three voters request collaboration, one specialist contributes before the lead answers.</p><p className="mt-3 text-xs text-ink-subtle">Text chats for this preview. Files, browsing, tools and voice come later.</p><div className="mt-7 flex flex-wrap justify-center gap-2">{["Explain why confidence intervals are often misunderstood.","Help me plan and critique an argument for my essay."].map(s=><button key={s} onClick={()=>setInput(s)} className="max-w-xs rounded-2xl border border-line px-4 py-3 text-left text-sm hover:bg-surface-100">{s}</button>)}</div></div>}
          {loading&&<p role="status" className="text-sm text-ink-muted">Opening chat…</p>}
          {dropped&&<p className="mb-5 rounded-xl border border-line p-3 text-xs text-ink-muted">Selected recent context and any available summary are used. Older history may be omitted or partially summarized. This view shows the latest {ORBIT.contextRows} saved messages.</p>}
          {messages.map(m=><article key={m.id} className={`mb-7 ${m.role==="user"?"ml-auto max-w-[90%] rounded-2xl bg-surface-200 p-4":""}`}>
            {m.role==="assistant"&&m.orbit_details&&<Routing decision={m.orbit_details}/>}
            {m.content&&<Markdown text={hideRememberMarkers(m.content)} final={m.status!=="streaming"}/>}
            {m.role==="assistant"&&m.status==="partial"&&<p className="mt-2 text-xs text-ink-muted">Incomplete answer</p>}
          </article>)}
          {busy&&<p role="status" aria-live="polite" className="mb-4 text-sm text-brand">{PHASES[phase]??"Working…"}</p>}
          {busy&&decision&&!messages.some(m=>m.orbit_details)&&<Routing decision={decision}/>}
          {error&&<p role="alert" className="mb-4 rounded-xl border border-line-strong bg-surface-100 p-4 text-sm">{error}</p>}
          <div ref={bottom}/>
        </div>
      </div>
      <form onSubmit={e=>{e.preventDefault();void send();}} className="mx-auto w-full max-w-3xl px-4 pb-4">
        <div className="rounded-3xl border border-line-strong bg-surface-100 p-3 shadow-composer"><textarea aria-label="Message Orbit" placeholder="Ask Orbit anything…" maxLength={24000} rows={3} value={input} disabled={busy||loading} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}} className="w-full resize-none bg-transparent px-2 py-1 text-base outline-none disabled:opacity-50"/><div className="flex items-center justify-between gap-3"><span className="px-2 text-xs text-ink-muted">4 votes · up to 1 specialist · 1 lead answer</span>{busy?<button type="button" onClick={()=>controller.current?.abort()} className="rounded-full border border-line px-4 py-2 text-sm">Stop</button>:<button disabled={!input.trim()||loading} className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-on-brand disabled:opacity-40">Send</button>}</div></div>
        <p className="mt-2 text-center text-[11px] leading-4 text-ink-subtle">Orbit can make mistakes. Four-model routing adds time and usage; it has not yet been shown to outperform an individual model.</p>
      </form>
    </main>
  </div>;
}
