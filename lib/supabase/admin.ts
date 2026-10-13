import { createClient } from "@supabase/supabase-js";

// Server-only client with the Supabase secret key. Bypasses RLS — use it ONLY for budget functions,
// settings, metadata-only analytics/staff aggregates and uploading generated images, never to read or write a student's chats.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_SECRET_KEY is not set");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
