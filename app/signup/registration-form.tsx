"use client";

import { useState } from "react";
import Link from "next/link";
import { INSTITUTIONS, institution } from "@/config/institutions";
import { Field, FormAlert, inputClass, primaryButtonClass } from "@/components/auth-ui";
import { SignUpForm } from "./signup-form";

export function RegistrationForm() {
  const [school, setSchool] = useState("");
  const selected = institution(school);
  return (
    <div className="space-y-6">
      <div>
        <label htmlFor="institution" className="text-sm font-medium">Institution</label>
        <select id="institution" value={school} onChange={(e) => setSchool(e.target.value)} className={`${inputClass} mt-2`} aria-controls="registration-details">
          <option value="" disabled>Select your institution</option>
          {INSTITUTIONS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value="other">My institution isn’t listed</option>
        </select>
      </div>
      <div id="registration-details">
        {/* Keep Western's form mounted so switching schools preserves verification progress. */}
        <div hidden={school !== "western"}>
          <p className="mb-5 text-sm leading-6 text-ink-muted">Create your Western account. We’ll email you a code to verify your @uwo.ca address. Early-access approval may still be required.</p>
          <SignUpForm />
        </div>
        {school && school !== "western" && <WaitlistForm key={school} school={school} name={selected?.name} />}
        {!school && <p className="text-sm leading-6 text-ink-muted">Choose your institution to create a Western account or join your institution’s waitlist.</p>}
      </div>
    </div>
  );
}

function WaitlistForm({ school, name }: { school: string; name?: string }) {
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string>();

  async function join(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ institution: school, school: form.get("school"), email: form.get("email"), consent: form.get("consent") === "on", website: form.get("website") }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Please try again.");
      setJoined(true);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (joined) return <div role="status" className="rounded-xl border border-line bg-surface-200 p-5"><h2 className="text-lg font-medium">You’re on the list.</h2><p className="mt-3 text-sm leading-6 text-ink-muted">Your interest has been recorded. We’ll use your email for access invitations when available. No account or subscription has been created.</p></div>;

  return (
    <form onSubmit={join} className="space-y-4">
      <h2 className="text-lg font-medium">{name ? `${name} waitlist` : "Join your institution’s waitlist"}</h2>
      <p className="text-sm leading-6 text-ink-muted">Orbit accounts are currently for Western students. Join the waitlist for access updates at your Canadian institution.</p>
      <fieldset disabled={busy} className="space-y-4">
        {school === "other" && <Field label="Canadian institution name" id="school" required minLength={2} maxLength={120} autoComplete="organization" />}
        <Field label="Email address" id="waitlist-email" name="email" type="email" autoComplete="email" required maxLength={254} placeholder="you@example.ca" />
        <div className="hidden" aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
        <label className="flex items-start gap-3 text-xs leading-5 text-ink-muted"><input type="checkbox" name="consent" required className="mt-1 h-4 w-4 shrink-0 accent-brand" />I agree to Orbit storing my email and institution to manage the waitlist and send access invitations. The full privacy policy and public contact channel are being finalized.</label>
        <Link href="/privacy" className="block text-xs text-brand underline">Read the current data-use notice</Link>
        <FormAlert error={error} />
        <button className={primaryButtonClass} disabled={busy}>{busy ? "Joining…" : "Join the waitlist"}</button>
      </fieldset>
      <p className="text-xs leading-5 text-ink-subtle">No account or payment required. Joining does not verify student status or guarantee an access date.</p>
    </form>
  );
}
