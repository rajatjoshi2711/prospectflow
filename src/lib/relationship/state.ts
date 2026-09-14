import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * "Is relationship scoring running right now, and what has it produced?"
 *
 * WHY THIS EXISTS
 * ---------------
 * Scoring runs in Inngest, out of band from every page. Before Phase 7 the only
 * observable was the `RelationshipStrengthScore` table, and an empty table means
 * three different things: the job has not started, the job is mid-flight, or the
 * job finished and correctly found nothing to score (nobody in the export has a
 * message or an invitation note). Rendering all three as a silent "Not yet
 * scored" told the reader nothing about whether waiting would help.
 *
 * `User.relationshipScoreRequestedAt` / `relationshipScoreComputedAt` separate
 * them: requested-after-computed is genuinely in flight, and a computed stamp
 * with zero rows is a finished run with no signal — which is the truth, and the
 * same three-outcome honesty the scoring itself observes.
 *
 * NEVER FABRICATES: this reports on the JOB, not on the data. It never invents
 * a score, and `scoredCount: 0` is always reported as zero scores, never as a
 * weak network.
 */

/**
 * A run older than this with no completion stamp is reported as `stalled`
 * rather than `running`. Inngest retries and the whole pass is capped at a few
 * minutes of model calls, so anything past this is a failure, not patience.
 */
const STALE_AFTER_MINUTES = 30;

export type RelationshipScoringState = {
  status:
    /** No completed import, so there is nothing to score. */
    | "no-import"
    /** A run was asked for and has not reported back yet. */
    | "running"
    /** Asked for long enough ago that something has gone wrong. */
    | "stalled"
    /** A run finished. `scoredCount` may still be 0 — see below. */
    | "ready"
    /** Nothing has ever been requested (e.g. imports predate Phase 7). */
    | "never-run";
  requestedAt: Date | null;
  computedAt: Date | null;
  /**
   * Stored scores this user currently has. Zero after a finished run is a real
   * answer: the export carried no messages or invitation notes for anyone.
   */
  scoredCount: number;
};

export async function getRelationshipScoringState(
  userId: string,
  options: { hasCompletedImport: boolean },
): Promise<RelationshipScoringState> {
  const [user, scoredCount] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { relationshipScoreRequestedAt: true, relationshipScoreComputedAt: true },
    }),
    prisma.relationshipStrengthScore.count({ where: { userId } }),
  ]);

  const requestedAt = user?.relationshipScoreRequestedAt ?? null;
  const computedAt = user?.relationshipScoreComputedAt ?? null;
  const base = { requestedAt, computedAt, scoredCount };

  if (!options.hasCompletedImport) return { ...base, status: "no-import" };

  const inFlight =
    requestedAt !== null && (computedAt === null || computedAt.getTime() < requestedAt.getTime());

  if (inFlight) {
    const ageMinutes = (Date.now() - requestedAt!.getTime()) / 60_000;
    return { ...base, status: ageMinutes > STALE_AFTER_MINUTES ? "stalled" : "running" };
  }

  if (computedAt !== null) return { ...base, status: "ready" };
  // Scores exist but no stamp does — an import from before these columns
  // existed. Treat it as finished rather than implying work is pending.
  if (scoredCount > 0) return { ...base, status: "ready" };
  return { ...base, status: "never-run" };
}

/**
 * Marks a scoring run as requested for one or more users.
 *
 * Called at every point that ENQUEUES `relationship/recompute.requested` — the
 * import pipeline, the nightly sweep, and the manual re-score control — so the
 * "running" state cannot drift from what was actually asked for. Best-effort
 * for the same reason the completion stamp is: the work has been (or is about
 * to be) enqueued regardless, and losing a timestamp must not lose a run.
 */
export async function markScoringRequested(where: {
  userId?: string;
  organizationId?: string;
}): Promise<void> {
  try {
    if (where.userId) {
      await prisma.user.update({
        where: { id: where.userId },
        data: { relationshipScoreRequestedAt: new Date() },
      });
      return;
    }
    if (where.organizationId) {
      await prisma.user.updateMany({
        where: { organizationId: where.organizationId },
        data: { relationshipScoreRequestedAt: new Date() },
      });
    }
  } catch (error) {
    console.error("Failed to stamp relationshipScoreRequestedAt", { where, error });
  }
}
