import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/guards";
import { consumeAiQuota, rateLimitResponse } from "@/lib/ai/rate-limit";
import { inngest } from "@/inngest/client";
import { firstIssue } from "@/lib/matching/schemas";
import { getLatestCompleteBatch } from "@/lib/insights/prospects";
import {
  getRelationshipScoringState,
  markScoringRequested,
} from "@/lib/relationship/state";

/**
 * "Re-score now" (Phase 7).
 *
 * WHY: before this, relationship scoring only ran on import or on the 3am cron.
 * A member who fixed something — or who simply wanted to know whether the empty
 * column would ever fill in — had no way to ask, and no way to see that a run
 * was under way.
 *
 * GET  -> the current scoring state, for the control's polling.
 * POST -> enqueue a run.
 *
 * SCOPING
 *   A MEMBER can only ever re-score themselves: `userId` is taken from the
 *   session and is not accepted from the body, so there is no id to tamper
 *   with. An ADMIN may additionally pass `scope: "org"` to re-score every member
 *   plus regenerate the org's quick suggestions — the same fan-out the nightly
 *   sweep does, on demand. The org id also comes from the session.
 *
 * COST
 *   This is an AI-invoking route (one run is up to ~27 model calls for the
 *   user's scores, plus one for suggestions), so it goes through the same
 *   `consumeAiQuota` guard as ProspectAsk, on its own much tighter bucket.
 *   Rate limiting happens BEFORE the event is enqueued — the actual spend
 *   happens in Inngest, where it cannot be charged back to a request.
 *
 *   The org-wide variant is charged the same single unit, deliberately: it is
 *   an admin action, and the underlying job is already concurrency-limited to
 *   one run per org, so repeated presses coalesce rather than multiply.
 */

export const runtime = "nodejs";

const bodySchema = z.object({
  /** `self` (the default) or `org` (admins only). */
  scope: z.enum(["self", "org"]).optional(),
});

export async function GET() {
  const guard = await requireSession();
  if (!guard.ok) return guard.response;

  const batch = await getLatestCompleteBatch(guard.session.userId);
  const state = await getRelationshipScoringState(guard.session.userId, {
    hasCompletedImport: batch !== null,
  });

  return NextResponse.json({
    status: state.status,
    scoredCount: state.scoredCount,
    requestedAt: state.requestedAt?.toISOString() ?? null,
    computedAt: state.computedAt?.toISOString() ?? null,
  });
}

export async function POST(request: Request) {
  const guard = await requireSession();
  if (!guard.ok) return guard.response;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  const wantsOrg = parsed.data.scope === "org";
  if (wantsOrg && guard.session.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only an admin can re-score the whole organization." },
      { status: 403 },
    );
  }

  const batch = await getLatestCompleteBatch(guard.session.userId);
  if (!wantsOrg && !batch) {
    // Nothing to score. Say so instead of enqueueing a job that will do nothing
    // and leave the UI reporting a run that never had any work in it.
    return NextResponse.json(
      {
        error:
          "There is nothing to score yet — upload a LinkedIn export first and scoring runs automatically.",
      },
      { status: 409 },
    );
  }

  const quota = await consumeAiQuota({
    userId: guard.session.userId,
    organizationId: guard.session.organizationId,
    action: "recompute",
  });
  if (!quota.ok) return rateLimitResponse(quota);

  await markScoringRequested(
    wantsOrg
      ? { organizationId: guard.session.organizationId }
      : { userId: guard.session.userId },
  );

  try {
    await inngest.send([
      {
        name: "relationship/recompute.requested",
        data: {
          organizationId: guard.session.organizationId,
          ...(wantsOrg ? {} : { userId: guard.session.userId }),
          reason: wantsOrg ? "manual:org" : "manual:self",
        },
      },
      // Suggestions are org-wide by definition and are rebuilt from the scores
      // this run produces, so an org recompute refreshes them too. A personal
      // re-score deliberately does not: it would make one member's button
      // rewrite everyone else's queue.
      ...(wantsOrg
        ? [
            {
              name: "suggestions/recompute.requested" as const,
              data: {
                organizationId: guard.session.organizationId,
                reason: "manual:org",
              },
            },
          ]
        : []),
    ]);
  } catch (error) {
    console.error("Failed to enqueue relationship recompute", error);
    return NextResponse.json(
      {
        error:
          "We could not start the re-score just now. It will run automatically after your next import, or overnight.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, scope: wantsOrg ? "org" : "self", status: "running" });
}
