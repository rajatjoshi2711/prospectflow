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
/**
 * Server-side "is anyone signed in?" guard for API routes.
 *
 * Distinct from `requireAdmin` because some resources are PERSONAL rather than
 * org-managed — campaigns are the first (Phase 5). For those, this guard
 * establishes WHO is calling, and every query below it must then be scoped by
 * `session.userId`. Being signed in is not on its own permission to touch a
 * given row: a member must never be able to read or mutate another member's
 * campaign by guessing an id, so the ownership filter belongs in the query
 * itself, not in a separate check.
 */
export async function requireSession(): Promise<
  { ok: true; session: SessionPayload } | { ok: false; response: NextResponse }
> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true, session };
}

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
