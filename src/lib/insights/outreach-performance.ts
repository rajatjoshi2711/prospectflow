import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * "Is your outreach working?" — the two performance measures on the dashboard.
 *
 * Both are computed in Postgres over the signed-in user's latest COMPLETE
 * import batch. Nothing here loads message or invitation rows into JS.
 */

/**
 * Invitation acceptance, INFERRED.
 *
 * `Invitation` has no accepted column — LinkedIn's export does not carry one.
 * What it does carry is every invitation the account sent, and a separate list
 * of everyone the account is now connected to. So an invitation is inferred
 * accepted when its counterparty key also appears in this batch's
 * `Connection` rows. The UI states this plainly; see `ACCEPTANCE_CAVEATS`.
 */
export type AcceptancePoint = {
  /** First day of the month, from `sentAt`. */
  month: Date;
  sent: number;
  /** Inferred accepted — see above. */
  accepted: number;
};

export type InvitationAcceptance = {
  points: AcceptancePoint[];
  sentTotal: number;
  acceptedTotal: number;
  /**
   * Sent invitations with no `sentAt`. They cannot be placed on the time axis
   * and are excluded from the chart rather than bucketed into an invented
   * month. Reported, never dropped silently.
   */
  undatedSent: number;
  /**
   * Invitation rows whose `direction` column is missing or is neither outgoing
   * nor incoming. Not counted as sent, because we cannot say they were.
   */
  directionUnknown: number;
};

/**
 * Stated verbatim in the UI. Every one of these is a real limitation of
 * inferring acceptance from a connection list rather than a status column.
 */
export const ACCEPTANCE_CAVEATS = [
  "Acceptance is inferred, not recorded: LinkedIn's export has no accepted column. An invitation counts as accepted when the person it was sent to is in your current connections list.",
  "An invitation that was sent, declined, then sent again and accepted looks the same as one accepted first time — the export cannot tell them apart, so the rate is an upper bound in that case.",
  "Someone who accepted and later disconnected is no longer in your connections, so their invitation reads as never accepted — which makes the rate a lower bound in that case.",
  "People are matched by profile URL where the export gives one, and by display name otherwise. Two connections with the same display name cannot be told apart.",
] as const;

/**
 * QUERY: one pass over this batch's `Invitation` rows (~1,200 for a full
 * export, index scan on `importBatchId`), grouped by `date_trunc('month')`.
 * Acceptance is a hash probe into the set of connection keys, which is built
 * once as a `UNION` of the batch's distinct `identityKey` and `nameKey` values.
 *
 * `direction` is the raw export column and is compared case-insensitively
 * against both spellings LinkedIn has used — `OUTGOING` in the current export
 * format and `SENT` in older ones. `process-import.ts` stores it unmodified, so
 * normalization has to happen here.
 *
 * COST: two index scans plus two hash aggregates over a few thousand rows
 * total. Existing `@@index([importBatchId])` on both tables covers it.
 */
export async function loadInvitationAcceptance(importBatchId: string): Promise<InvitationAcceptance> {
  const [buckets, tallies] = await Promise.all([
    prisma.$queryRaw<{ month: Date; sent: number; accepted: number }[]>`
      WITH connected AS (
        SELECT DISTINCT "identityKey" AS k
        FROM "Connection" WHERE "importBatchId" = ${importBatchId}
        UNION
        SELECT DISTINCT "nameKey" AS k
        FROM "Connection" WHERE "importBatchId" = ${importBatchId} AND "nameKey" IS NOT NULL
      ),
      sent AS (
        SELECT i."identityKey" AS "identityKey", i."nameKey" AS "nameKey", i."sentAt" AS "sentAt"
        FROM "Invitation" i
        WHERE i."importBatchId" = ${importBatchId}
          AND i."sentAt" IS NOT NULL
          AND lower(trim(coalesce(i."direction", ''))) IN ('outgoing', 'sent')
      )
      SELECT date_trunc('month', s."sentAt") AS month,
             COUNT(*)::int AS sent,
             (COUNT(*) FILTER (
               WHERE EXISTS (SELECT 1 FROM connected c WHERE c.k = s."identityKey")
                  OR (s."nameKey" IS NOT NULL
                      AND EXISTS (SELECT 1 FROM connected c WHERE c.k = s."nameKey"))
             ))::int AS accepted
      FROM sent s
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    prisma.$queryRaw<{ undatedSent: number; directionUnknown: number }[]>`
      SELECT
        (COUNT(*) FILTER (
          WHERE lower(trim(coalesce("direction", ''))) IN ('outgoing', 'sent')
            AND "sentAt" IS NULL
        ))::int AS "undatedSent",
        (COUNT(*) FILTER (
          WHERE lower(trim(coalesce("direction", ''))) NOT IN ('outgoing', 'sent', 'incoming', 'received')
        ))::int AS "directionUnknown"
      FROM "Invitation"
      WHERE "importBatchId" = ${importBatchId}
    `,
  ]);

  return {
    points: buckets,
    sentTotal: buckets.reduce((sum, point) => sum + point.sent, 0),
    acceptedTotal: buckets.reduce((sum, point) => sum + point.accepted, 0),
    undatedSent: tallies[0]?.undatedSent ?? 0,
    directionUnknown: tallies[0]?.directionUnknown ?? 0,
  };
}

export type ReplyPerformance = {
  /** Outbound stretches of conversation that were followed by a reply. */
  repliedOutreach: number;
  /** All outbound stretches, replied or not. */
  totalOutreach: number;
  /** Median seconds from the outreach to the reply. Null when nothing replied. */
  medianReplySeconds: number | null;
  /** Total `MessageRecord` rows in this batch, for context on the exclusions. */
  totalMessages: number;
  /**
   * Messages with `senderIsUser IS NULL` — group threads where ingestion could
   * not work out who sent what. Excluded from both measures above and stated in
   * the UI, because a message of unknown direction is neither an outreach nor a
   * reply and guessing either way would invent a number.
   */
  directionUnknownMessages: number;
  /**
   * Messages with no conversation id or no timestamp. A reply cannot be tied to
   * an outreach without both, so these are excluded too — also stated.
   */
  unthreadedMessages: number;
};

/**
 * Reply rate and median response latency, UNSEGMENTED.
 *
 * WHAT COUNTS AS ONE OUTREACH: a maximal run of consecutive outbound messages
 * in a conversation. Three follow-ups with no reply in between are one attempt
 * that went unanswered, not three — counting each message separately would
 * punish the rate for every follow-up and reward it when a chatty thread
 * happened to be broken up. Latency is measured from the FIRST message of the
 * run to the first inbound message after it, so a follow-up does not restart
 * the clock on a reply the person was always going to send.
 *
 * NO ICP SEGMENTATION, deliberately — this is one number for all outreach.
 *
 * QUERY: window functions over the batch's directed, threaded messages —
 * `LAG` marks each direction change, a running `SUM` turns those into run ids,
 * one `GROUP BY` collapses each run, and `LEAD` looks at the run that follows.
 * `PERCENTILE_CONT(0.5)` gives a true median in the database; loading the gaps
 * into JS to sort them is exactly the thing this file exists to avoid.
 *
 * COST: one index scan of `MessageRecord` on `importBatchId` (~18.6k rows) and
 * a small number of sorts partitioned by `conversationId`. All of it is one
 * pass over an already-fetched row set; nothing is re-probed per row, and the
 * result is three scalars. A composite `(importBatchId, conversationId, sentAt)`
 * index would let the window functions read in order instead of sorting, but at
 * 18.6k rows the sort is not what makes this page slow, so no migration.
 */
export async function loadReplyPerformance(importBatchId: string): Promise<ReplyPerformance> {
  const [stats, exclusions] = await Promise.all([
    prisma.$queryRaw<
      { totalOutreach: number; repliedOutreach: number; medianReplySeconds: number | null }[]
    >`
      WITH directed AS (
        SELECT "conversationId", "senderIsUser", "sentAt", "id"
        FROM "MessageRecord"
        WHERE "importBatchId" = ${importBatchId}
          AND "conversationId" IS NOT NULL
          AND "sentAt" IS NOT NULL
          AND "senderIsUser" IS NOT NULL
      ),
      marked AS (
        SELECT d.*,
               CASE
                 WHEN LAG("senderIsUser") OVER w IS NULL
                   OR LAG("senderIsUser") OVER w <> "senderIsUser"
                 THEN 1 ELSE 0
               END AS "isRunStart"
        FROM directed d
        WINDOW w AS (PARTITION BY "conversationId" ORDER BY "sentAt", "id")
      ),
      runs AS (
        SELECT m.*,
               SUM("isRunStart") OVER (
                 PARTITION BY "conversationId" ORDER BY "sentAt", "id"
                 ROWS UNBOUNDED PRECEDING
               ) AS "runId"
        FROM marked m
      ),
      collapsed AS (
        SELECT "conversationId", "runId",
               bool_and("senderIsUser") AS outbound,
               MIN("sentAt") AS "startedAt"
        FROM runs
        GROUP BY "conversationId", "runId"
      ),
      paired AS (
        SELECT c.*,
               LEAD("startedAt") OVER (PARTITION BY "conversationId" ORDER BY "runId") AS "nextStartedAt",
               LEAD(outbound) OVER (PARTITION BY "conversationId" ORDER BY "runId") AS "nextOutbound"
        FROM collapsed c
      )
      SELECT COUNT(*)::int AS "totalOutreach",
             (COUNT(*) FILTER (WHERE "nextOutbound" = false))::int AS "repliedOutreach",
             PERCENTILE_CONT(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM ("nextStartedAt" - "startedAt"))::double precision
             ) FILTER (WHERE "nextOutbound" = false) AS "medianReplySeconds"
      FROM paired
      WHERE outbound
    `,
    prisma.$queryRaw<
      { totalMessages: number; directionUnknownMessages: number; unthreadedMessages: number }[]
    >`
      SELECT COUNT(*)::int AS "totalMessages",
             (COUNT(*) FILTER (WHERE "senderIsUser" IS NULL))::int AS "directionUnknownMessages",
             (COUNT(*) FILTER (
               WHERE "senderIsUser" IS NOT NULL
                 AND ("conversationId" IS NULL OR "sentAt" IS NULL)
             ))::int AS "unthreadedMessages"
      FROM "MessageRecord"
      WHERE "importBatchId" = ${importBatchId}
    `,
  ]);

  return {
    totalOutreach: stats[0]?.totalOutreach ?? 0,
    repliedOutreach: stats[0]?.repliedOutreach ?? 0,
    medianReplySeconds: stats[0]?.medianReplySeconds ?? null,
    totalMessages: exclusions[0]?.totalMessages ?? 0,
    directionUnknownMessages: exclusions[0]?.directionUnknownMessages ?? 0,
    unthreadedMessages: exclusions[0]?.unthreadedMessages ?? 0,
  };
}
