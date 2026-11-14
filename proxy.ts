import { NextResponse, type NextRequest } from "next/server";

/**
 * Optional HTTP Basic Auth for the whole app. Enabled only when
 * WEBNEST_PASSWORD is set (any username is accepted).
 */
export function proxy(req: NextRequest) {
  const password = process.env.WEBNEST_PASSWORD;
  if (!password) return NextResponse.next();
  const header = req.headers.get("authorization") || "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const given = decoded.slice(decoded.indexOf(":") + 1);
      if (given.length === password.length) {
        let diff = 0;
        for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ password.charCodeAt(i);
        if (diff === 0) return NextResponse.next();
      }
    } catch {
      /* fall through */
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="WebNest", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
