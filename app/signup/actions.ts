"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAllowedEmail, normalizeEmail } from "@/lib/auth/eligibility";
import { friendlyAuthError, logAuthError } from "@/lib/auth/errors";
import { institution } from "@/config/institutions";
import { passwordProblem } from "@/lib/auth/password";
import { resendSignupCode, verifyEmailCode } from "@/lib/auth/flows";

export type SignUpState = {
  step: "details" | "verify";
  email: string;
  error?: string;
  message?: string;
};

export async function signUpAction(prev: SignUpState, formData: FormData): Promise<SignUpState> {
  const intent = String(formData.get("intent") ?? "signup");
  const email = normalizeEmail(String(formData.get("email") ?? prev.email ?? ""));

  const school = institution(formData.get("institution"));
  if (school?.id !== "western") {
    return { step: "details", email, error: "Select Western University to create an account. Other institutions can join the waitlist." };
  }

  if (intent === "back") return { step: "details", email };
  if (!isAllowedEmail(email)) {
    return { step: "details", email, error: "Orbit AI is only open to @uwo.ca email addresses." };
  }

  if (intent === "verify") {
    const problem = await verifyEmailCode(email, String(formData.get("code") ?? ""));
    if (problem) return { step: "verify", email, error: problem };
    redirect("/");
  }
  if (intent === "resend") {
    const problem = await resendSignupCode(email);
    return problem
      ? { step: "verify", email, error: problem }
      : { step: "verify", email, message: `We sent a new code to ${email}.` };
  }

  const password = String(formData.get("password") ?? "");
  const problem = passwordProblem(password, String(formData.get("confirm") ?? ""));
  if (problem) return { step: "details", email, error: problem };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { institution: school.id, institution_name: school.name } } });
  if (error) {
    logAuthError("signUp", error);
    return { step: "details", email, error: friendlyAuthError(error, "send") };
  }
  // Supabase hides existing accounts by returning a user with no identities.
  if (data.user && data.user.identities?.length === 0) {
    return { step: "details", email, error: "An account with this email already exists. Sign in instead." };
  }
  // Email confirmation is turned off in Supabase: user is already signed in.
  if (data.session) redirect("/");

  return { step: "verify", email, message: `We sent a 6-digit code to ${email}. It can take a minute to arrive — check Junk too.` };
}
