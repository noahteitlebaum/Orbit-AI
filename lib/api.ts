import { getUserAccess } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

// Shared guard for API routes: verified @uwo.ca account that is past the waitlist.
// Returns the user plus a Supabase client bound to their session (RLS applies to every query).
type AppUser = { user: NonNullable<Awaited<ReturnType<typeof getUserAccess>>>["user"]; supabase: Awaited<ReturnType<typeof createClient>> };

export async function requireAppUser(): Promise<{ error: Response } | AppUser> {
  const result = await getUserAccess();
  if (!result) return { error: Response.json({ error: "not_signed_in" }, { status: 401 }) };
  if (result.access !== "app") return { error: Response.json({ error: "waitlisted" }, { status: 403 }) };
  return { user: result.user, supabase: await createClient() };
}

export const json = (body: unknown, status = 200) => Response.json(body, { status });

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

// Supabase/Postgres errors that mean a migration hasn't been run (missing table, column or constraint change).
const SETUP_CODES = new Set(["42P01", "42703", "23502", "PGRST204", "PGRST205", "42883"]);

/** JSON error for a failed query. Missing-schema errors say which migration to run, so setup problems are obvious. */
export function dbError(error: { code?: string } | null | undefined, fallback: string, status = 500) {
  if (error?.code && SETUP_CODES.has(error.code)) {
    return Response.json(
      { error: "db_setup", message: "The database isn't fully set up. Run every file in supabase/migrations (0001, 0002, …) in order in the Supabase SQL Editor." },
      { status: 503 },
    );
  }
  return Response.json({ error: fallback, code: error?.code }, { status });
}
