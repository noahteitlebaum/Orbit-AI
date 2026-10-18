import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Runs before every page request: keeps the login session fresh and
// sends signed-out visitors to /login. Real access checks still happen on the server (lib/auth/session.ts).
export async function proxy(request: NextRequest) {
  if (["/privacy", "/terms", "/contact", "/api/waitlist"].includes(request.nextUrl.pathname) || (request.nextUrl.pathname === "/" && !process.env.NEXT_PUBLIC_SUPABASE_URL)) return NextResponse.next();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
          Object.entries(headers ?? {}).forEach(([key, value]) =>
            response.headers.set(key, value),
          );
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims);

  // API routes do their own auth check and answer 401 (a redirect would hand HTML to fetch()).
  if (!signedIn && !isPublicPath(request.nextUrl.pathname) && !request.nextUrl.pathname.startsWith("/api/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return response;
}

function isPublicPath(path: string) {
  return path === "/" || ["/login", "/signup", "/reset", "/auth/"].some((p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|python-worker\\.mjs|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
