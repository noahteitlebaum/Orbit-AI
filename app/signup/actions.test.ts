import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ signup: vi.fn(), verify: vi.fn(), resend: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { signUp: mocks.signup } }) }));
vi.mock("@/lib/auth/flows", () => ({ verifyEmailCode: mocks.verify, resendSignupCode: mocks.resend }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
import { signUpAction } from "./actions";
const previous = { step: "details" as const, email: "" };
function form(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ institution: "western", email: " Student@UWO.ca ", password: "Synthetic123", confirm: "Synthetic123", ...values })) data.set(key, value);
  return data;
}
describe("institution-aware Western registration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.signup.mockResolvedValue({ data: { user: { identities: [{}] }, session: null }, error: null });
  });
  it("stores the server-resolved institution with normalized credentials and requests verification", async () => {
    expect(await signUpAction(previous, form())).toMatchObject({ step: "verify", email: "student@uwo.ca" });
    expect(mocks.signup).toHaveBeenCalledWith({ email: "student@uwo.ca", password: "Synthetic123", options: { data: { institution: "western", institution_name: "Western University" } } });
  });
  it.each(["waterloo", "other", "fake", ""])("never creates accounts for institution %s", async (institution) => {
    expect((await signUpAction(previous, form({ institution }))).error).toContain("Select Western");
    expect(mocks.signup).not.toHaveBeenCalled();
  });
  it.each(["student@waterloo.ca", "student@sub.uwo.ca", "student@uwo.ca.evil.com"])("rejects non-Western or lookalike email %s", async (email) => {
    expect((await signUpAction(previous, form({ email }))).error).toContain("@uwo.ca");
    expect(mocks.signup).not.toHaveBeenCalled();
  });
  it("retains verification, resend, and change-email actions", async () => {
    mocks.verify.mockResolvedValue(null);
    await expect(signUpAction(previous, form({ intent: "verify", code: "123456" }))).rejects.toThrow("redirect:/");
    expect(mocks.verify).toHaveBeenCalledWith("student@uwo.ca", "123456");
    mocks.resend.mockResolvedValue(null);
    expect(await signUpAction(previous, form({ intent: "resend" }))).toMatchObject({ step: "verify" });
    expect(mocks.resend).toHaveBeenCalledWith("student@uwo.ca");
    expect(await signUpAction(previous, form({ intent: "back" }))).toEqual({ step: "details", email: "student@uwo.ca" });
  });
  it("keeps an invalid code on the verification form", async () => {
    mocks.verify.mockResolvedValue("Invalid code");
    expect(await signUpAction(previous, form({ intent: "verify", code: "000000" }))).toMatchObject({ step: "verify", error: "Invalid code" });
  });
  it("rejects non-Western institution claims even on verification requests", async () => {
    expect((await signUpAction(previous, form({ intent: "verify", institution: "other" }))).error).toContain("Select Western");
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
