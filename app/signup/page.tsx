import { redirect } from "next/navigation";
import { getEligibleUser } from "@/lib/auth/session";
import { AuthCard, TextLink } from "@/components/auth-ui";
import { RegistrationForm } from "./registration-form";

export default async function SignUpPage() {
  if (await getEligibleUser()) redirect("/");

  return (
    <AuthCard
      title="Get started with Orbit"
      subtitle="Start with your institution."
      footer={<>Already have an account? <TextLink href="/login">Sign in</TextLink></>}
    >
      <RegistrationForm />
    </AuthCard>
  );
}
