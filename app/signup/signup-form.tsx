"use client";

import { useActionState } from "react";
import { Field, FormAlert, linkButtonClass, primaryButtonClass } from "@/components/auth-ui";
import { PASSWORD_MIN } from "@/lib/auth/password";
import { signUpAction, type SignUpState } from "./actions";

export function SignUpForm() {
  const [state, action, pending] = useActionState<SignUpState, FormData>(signUpAction, {
    step: "details",
    email: "",
  });

  if (state.step === "verify") {
    return (
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="institution" value="western" />
        <FormAlert error={state.error} message={state.message} />
        <input type="hidden" name="email" value={state.email} />
        <Field label="Verification code" id="code" required autoComplete="one-time-code" inputMode="numeric"
          maxLength={10} placeholder="123456" autoFocus />
        <button type="submit" name="intent" value="verify" disabled={pending} className={primaryButtonClass}>
          {pending ? "Checking…" : "Verify email"}
        </button>
        <div className="flex justify-between">
          <button type="submit" name="intent" value="resend" formNoValidate disabled={pending} className={linkButtonClass}>
            Send a new code
          </button>
          <button type="submit" name="intent" value="back" formNoValidate disabled={pending} className={linkButtonClass}>
            Change email
          </button>
        </div>
      </form>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="institution" value="western" />
      <FormAlert error={state.error} message={state.message} />
      <Field label="Western email" id="email" type="email" required autoComplete="email" inputMode="email"
        placeholder="you@uwo.ca" defaultValue={state.email} key={state.email} />
      <Field label="Password" id="password" type="password" required autoComplete="new-password"
        minLength={PASSWORD_MIN} hint={`At least ${PASSWORD_MIN} characters, with a letter and a number.`} />
      <Field label="Confirm password" id="confirm" type="password" required autoComplete="new-password"
        minLength={PASSWORD_MIN} />
      <button type="submit" name="intent" value="signup" disabled={pending} className={primaryButtonClass}>
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
