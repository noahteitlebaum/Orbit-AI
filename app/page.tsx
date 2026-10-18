import { LandingPage } from "@/components/landing-page";
import { redirect } from "next/navigation";
import { getUserAccess } from "@/lib/auth/session";
import { StudentApp } from "@/components/student-app";

export default async function Home() {
  if(!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) return <LandingPage/>;
  const result = await getUserAccess();
  if (!result) return <LandingPage/>;
  if (result.access === "waitlist") redirect("/waitlist");
  return <StudentApp email={result.user.email ?? ""} userId={result.user.id} />;
}
