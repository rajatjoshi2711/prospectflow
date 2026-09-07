import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { inngest } from "@/inngest/client";

/**
 * Nightly AI sweep, invoked by Vercel Cron (see `vercel.json`).
 *
 * WHY A SWEEP AT ALL
 * ------------------
 * Both Phase 6 jobs are also triggered by imports, but neither is only about
 * imports:
 *   - Quick suggestions span the WHOLE org graph. Alice's import changes what
 *     the org collectively knows, and so does an admin editing an ICP, and so
 *     does simple passage of time.
 *   - Relationship strength has a recency component. A conversation that was
 *     "90 days ago" in March is "a year ago" by December; without a sweep, a
 *     score silently ages into being wrong.
 *
 * AUTHORIZATION
 * -------------
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. This route fans out
 * work across EVERY organization, so it must never be callable by a visitor:
 * when `CRON_SECRET` is not configured the route refuses (503) rather than
 * running unauthenticated. Comparison is length-checked before the equality test
 * so a wrong-length token cannot be distinguished by timing alone.
 *
 * The route only ENQUEUES events; the actual work happens in the Inngest
 * functions, which are already concurrency-limited per org. So a duplicate cron
 * fire costs an event, not a duplicate run.
 */

export const dynamic = "force-dynamic";
/** Enqueueing is fast; the cap is here only so a large org list cannot hang. */
export const maxDuration = 60;

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= header.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET?.trim()) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured; the sweep is disabled." },
      { status: 503 },
    );
  }
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const organizations = await prisma.organization.findMany({ select: { id: true } });
  if (organizations.length === 0) {
    return NextResponse.json({ ok: true, organizations: 0, events: 0 });
  }

  const events = organizations.flatMap((organization) => [
    {
      name: "relationship/recompute.requested" as const,
      data: { organizationId: organization.id, reason: "cron:nightly" },
    },
    {
      name: "suggestions/recompute.requested" as const,
      data: { organizationId: organization.id, reason: "cron:nightly" },
    },
  ]);

  await inngest.send(events);

  return NextResponse.json({
    ok: true,
    organizations: organizations.length,
    events: events.length,
  });
}
