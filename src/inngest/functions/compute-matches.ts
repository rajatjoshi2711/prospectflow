import { NonRetriableError } from "inngest";
import { inngest, type MatchesRecomputeEvent } from "@/inngest/client";
import { computeMatchesForUser, listOrganizationUserIds } from "@/lib/matching/run";

/**
 * Recomputes `ProspectMatch` rows for an organization.
 *
 * TRIGGERS
 *   - after a successful import (`process-import.ts` sends this for the one
 *     user who just imported);
 *   - when an admin creates or edits an ICP or channel partner (the API route
 *     sends it for the whole org, narrowed to that definition). A DELETE needs
 *     no recompute — `ProspectMatch` cascades off the definition's FK.
 *
 * COST / LATENCY
 *   Work is bounded before any model is called: the pre-filter shortlists at
 *   most `MAX_CANDIDATES_PER_DEFINITION` (120) connections per definition, and
 *   scoring batches ten candidates per request. So one user with N definitions
 *   costs at most N x 12 model calls, no matter how large their network is,
 *   plus one connection query. Everything else is CPU-only string matching.
 *
 * RETRIES
 *   `retries: 1`. The provider itself retries once, and a failed scoring batch
 *   already degrades to a heuristic score rather than throwing, so extra
 *   Inngest retries would mostly re-do successful work. Writes are upserts, so
 *   a retry is safe.
 */
export const computeMatches = inngest.createFunction(
  {
    id: "compute-matches",
    retries: 1,
    // One run per org at a time: two concurrent runs would fight over the same
    // (connection, definition) rows and one would immediately prune the
    // other's writes.
    concurrency: { key: "event.data.organizationId", limit: 1 },
    triggers: [{ event: "matches/recompute.requested" }],
  },
  async ({
    event,
    step,
    logger,
  }: {
    event: MatchesRecomputeEvent;
    step: import("inngest").GetStepTools<typeof inngest>;
    logger: { info: (...args: unknown[]) => void };
  }) => {
    const { organizationId, userId, icpIds, channelPartnerIds } = event.data;
    if (!organizationId) {
      throw new NonRetriableError("matches/recompute.requested requires organizationId");
    }

    const userIds = await step.run("resolve-users", async () =>
      userId ? [userId] : listOrganizationUserIds(organizationId),
    );

    if (userIds.length === 0) {
      return { organizationId, users: 0, matchesWritten: 0 };
    }

    const only =
      icpIds !== undefined || channelPartnerIds !== undefined
        ? { icpIds, channelPartnerIds }
        : undefined;

    let matchesWritten = 0;
    let llmCalls = 0;

    // One step per user: a failure part-way through only replays the user it
    // was on, and every earlier user's (idempotent) result is memoized.
    for (const id of userIds) {
      const summary = await step.run(`score-user-${id}`, async () =>
        computeMatchesForUser({ userId: id, organizationId, only }),
      );
      matchesWritten += summary.matchesWritten;
      llmCalls += summary.llmCalls;
      logger.info("match run", summary);
    }

    return { organizationId, users: userIds.length, matchesWritten, llmCalls };
  },
);
