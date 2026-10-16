import { beforeEach,describe,expect,it,vi } from "vitest";
import { getModel } from "@/config/models";
import { ProviderError } from "@/lib/providers/types";
const state=vi.hoisted(()=>({disabled:false,reserve:vi.fn(),settle:vi.fn(),stream:vi.fn()}));
vi.mock("@/lib/billing/budget",()=>({isProviderDisabled:async()=>state.disabled,reserve:state.reserve,settle:state.settle}));
vi.mock("@/lib/providers",()=>({apiKeyFor:()=>"synthetic-key",ADAPTERS:{openai:{stream:state.stream}}}));
import { orbitCall, orbitInputTokens } from "./call";
import { reservationMicros } from "@/lib/chat/context";
const args=()=>({userId:"u",conversationId:"c",model:getModel("openai-luna")!,operation:"orbit_vote" as const,
 system:"Vote",history:[{role:"user" as const,content:"Synthetic question"}],maxOutput:100,signal:new AbortController().signal});
beforeEach(()=>{vi.clearAllMocks();state.disabled=false;state.reserve.mockResolvedValue({ok:true});state.settle.mockResolvedValue(undefined);
 state.stream.mockImplementation(async function*(){yield {delta:'{"nominee":"google"}'};yield {usage:{input:100,output:20,reasoning:0,cached:0}};yield {finish:"stop"};});});
describe("Orbit paid calls",()=>{
 it("shares the framing-aware helper estimate with the actual reservation",async()=>{
   const o=args();o.history=Array.from({length:50},()=>({role:"user",content:"short"}));
   const input=orbitInputTokens(o.system,o.history);
   expect(input).toBeGreaterThan(50*8);
   await orbitCall(o);
   expect(state.reserve.mock.calls[0][4]).toBe(reservationMicros(o.model,input,o.maxOutput));
 });
 it("reserves before dispatch and tags the phase",async()=>{
   await orbitCall(args());expect(state.reserve).toHaveBeenCalledWith("u",expect.any(String),"openai-luna","text",expect.any(Number),expect.objectContaining({operation:"orbit_vote"}));
   expect(state.reserve.mock.invocationCallOrder[0]).toBeLessThan(state.stream.mock.invocationCallOrder[0]);expect(state.settle).toHaveBeenCalledWith(expect.any(String),"settled",expect.any(Number),expect.any(Object),undefined,expect.any(Object));
 });
 it("blocks disabled providers before reservation or fetch",async()=>{
   state.disabled=true;await expect(orbitCall(args())).rejects.toThrow("orbit_provider_unavailable");expect(state.stream).not.toHaveBeenCalled();expect(state.reserve).not.toHaveBeenCalled();
 });
 it("does not dispatch without budget",async()=>{
   state.reserve.mockResolvedValue({ok:false,reason:"budget"});await expect(orbitCall(args())).rejects.toThrow("budget");expect(state.stream).not.toHaveBeenCalled();
 });
 it("keeps ambiguous network failures uncertain",async()=>{
   state.stream.mockImplementation(async function*(){throw new Error("synthetic private error");});await expect(orbitCall(args())).rejects.toThrow("orbit_call_failed");
   expect(state.settle).toHaveBeenCalledWith(expect.any(String),"uncertain",0,undefined,"orbit_call_failed");
 });
 it("releases known pre-start client rejections",async()=>{
   state.stream.mockImplementation(async function*(){throw new ProviderError("bad_request",400,false);});await expect(orbitCall(args())).rejects.toThrow();expect(state.settle).toHaveBeenCalledWith(expect.any(String),"released",0,undefined,"bad_request");
 });
 it.each(["length","unknown","blocked"])("rejects %s helper output even with usage",async finish=>{
   state.stream.mockImplementation(async function*(){yield {delta:"unfinished"};yield {usage:{input:100,output:20,reasoning:0,cached:0}};yield {finish};});
   await expect(orbitCall(args())).rejects.toThrow("orbit_incomplete_response");expect(state.settle).toHaveBeenCalledWith(expect.any(String),"settled",expect.any(Number),expect.any(Object),undefined,expect.any(Object));
 });
 it("requires a terminal signal",async()=>{
   state.stream.mockImplementation(async function*(){yield {delta:"text without finish"};});await expect(orbitCall(args())).rejects.toThrow("orbit_incomplete_response");expect(state.settle).toHaveBeenCalledWith(expect.any(String),"uncertain",0,undefined,"no_usage");
 });
});
