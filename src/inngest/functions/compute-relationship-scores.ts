import { NonRetriableError } from "inngest";
import { inngest, type RelationshipRecomputeEvent } from "@/inngest/client";
import { prisma } from "@/lib/prisma";
import { computeRelationshipScoresForUser } from "@/lib/relationship/run";

/**
 * Recomputes `RelationshipStrengthScore` for one user, or for a whole org.
 *
 * TRIGGERS
 *   - after a successful import (`process-import.ts` sends it for the one user
 *     who just imported);
 *   - the nightly cron sweep, org-wide, so a score's recency component does not
 *     drift as time passes since the last import.
 *   Re-runnable at any time: every write is an upsert on
 *   (userId, connectionId), and stale rows are pruned, so N runs produce the
 *   same table as one.
 *
 * COST / LATENCY
 *   Bounded before any model is called. Connections with no message and no
 *   invitation note are never scored (their absence is the "not yet scored"
 *   state the UI renders), and the rest are capped at 400 per user per run,
 *   batched 15 per request — at most 27 model calls per user, independent of
 *   network size.
 *
 * RETRIES
 *   `retries: 1`, matching `compute-matches`. The provider retries once
 *   internally and a failed scoring batch already degrades to the deterministic
 *   score rather than throwing, so more Inngest retries would mostly redo
 *   successful work. Worst case stays 2 (SDK) x 2 (Inngest).
 */
export const computeRelationshipScores = inngest.createFunction(
  {
    id: "compute-relationship-scores",
    retries: 1,
    // One run per org at a time. Two concurrent runs for the same user would
    // race on the upsert/prune pair and one would delete the other's writes.
    concurrency: { key: "event.data.organizationId", limit: 1 },
    triggers: [{ event: "relationship/recompute.requested" }],
  },
  async ({
    event,
    step,
    logger,
  }: {
    event: RelationshipRecomputeEvent;
    step: import("inngest").GetStepTools<typeof inngest>;
    logger: { info: (...args: unknown[]) => void };
  }) => {
    const { organizationId, userId } = event.data;
    if (!organizationId) {
      throw new NonRetriableError(
        "relationship/recompute.requested requires organizationId",
      );
    }

    const userIds = await step.run("resolve-users", async () => {
      if (userId) {
        // Verify the user really belongs to the org named in the event before
        // touching anything: the event is the only input, and a mismatched pair
        // must not be able to score across tenants.
        const user = await prisma.user.findFirst({
          where: { id: userId, organizationId },
          select: { id: true },
        });
        return user ? [user.id] : [];
      }
      const users = await prisma.user.findMany({
        where: { organizationId },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      return users.map((user) => user.id);
    });

    if (userIds.length === 0) {
      return { organizationId, users: 0, scored: 0 };
    }

    let scored = 0;
    let llmCalls = 0;

    // One step per user: a failure part-way through replays only the user it
    // was on, and every earlier user's idempotent result is memoized.
    for (const id of userIds) {
      const summary = await step.run(`score-relationships-${id}`, async () =>
        computeRelationshipScoresForUser(id),
      );
      scored += summary.scored;
      llmCalls += summary.llmCalls;
      logger.info("relationship run", summary);
    }

    return { organizationId, users: userIds.length, scored, llmCalls };
  },
);
