import "server-only";

import { NextResponse } from "next/server";
import { getSession, type SessionPayload } from "@/lib/auth/session";

/**
 * Server-side admin guard for API routes.
 *
 * Hiding a nav link is not access control — every mutating route calls this,
 * so a member who hand-crafts a request gets a 403 rather than a write. The
 * returned session also carries `organizationId`, which every query below it
 * must filter on.
 */
export async function requireAdmin(): Promise<
  { ok: true; session: SessionPayload } | { ok: false; response: NextResponse }
> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (session.role !== "ADMIN") {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { ok: true, session };
}
