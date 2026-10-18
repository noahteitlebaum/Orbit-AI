import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getUserAccess: mocks.access }));
vi.mock("@/components/student-app", () => ({ StudentApp: () => null }));
vi.mock("@/components/landing-page", () => ({ LandingPage: () => null }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
import Home from "./page";
import { LandingPage } from "@/components/landing-page";
import { StudentApp } from "@/components/student-app";
beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://synthetic.supabase.co"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "synthetic"); mocks.access.mockReset(); });
afterEach(() => vi.unstubAllEnvs());
it("shows the new landing to signed-out visitors", async () => {
 mocks.access.mockResolvedValue(null);
 expect((await Home()).type).toBe(LandingPage);
});
it("preserves eligible users' workspace", async () => {
 mocks.access.mockResolvedValue({ access: "app", user: { id: "synthetic", email: "synthetic@uwo.ca" } });
 expect(await Home()).toMatchObject({ type: StudentApp, props: { email: "synthetic@uwo.ca", userId: "synthetic" } });
});
it("preserves account waitlist routing", async () => {
 mocks.access.mockResolvedValue({ access: "waitlist", user: { id: "synthetic", email: "synthetic@uwo.ca" } });
 await expect(Home()).rejects.toThrow("redirect:/waitlist");
});
