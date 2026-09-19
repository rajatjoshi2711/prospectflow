import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * The three "do this next" action lists on the dashboard.
 *
 * WHY THIS IS ALL SQL
 * -------------------
 * A real export is ~18,650 messages and ~5,580 connections, and the dashboard
 * is server-rendered on every visit. Pulling message rows into JS to reduce
 * them (the shape `loadInteractionSignals` uses, which is correct for the tens
 * of rows on one prospect page) would move megabytes over the wire on every
 * page load. Every aggregate below is therefore computed in Postgres and only
 * the capped list of rows actually rendered comes back.
 *
 * THE JOIN, AND WHY IT IS TWO KEYS
 * --------------------------------
 * `MessageRecord` and `Invitation` are keyed to the COUNTERPARTY at ingestion
 * (see `process-import.ts`): `identityKey` is `url:<profile url>` when the
 * export carried a URL and `fallback:sha256(...)` otherwise, and `nameKey` is
 * `name:<normalized display name>`. A message's fallback hash is built from the
 * counterparty's display name alone, so it does NOT equal the connection's
 * fallback hash (which also folds in last name and company). URL-keyed rows
 * join exactly; everything else joins on `nameKey`. That name fallback is
 * inexact — two people with the same display name share a `nameKey` — and the
 * UI says so wherever these numbers are shown. This is the same join
 * `signals.ts` documents, expressed in SQL instead of in memory.
 *
 * TENANCY: every query is filtered to a single `importBatchId`, which the
 * caller has already resolved from the signed-in user's own latest COMPLETE
 * batch. No query here can see another user's rows.
 */

/** Rows rendered per action list. The rest is reported as a count. */
export const ACTION_LIST_LIMIT = 6;

/** "Recently connected" window. Warmth after an accept fades fast. */
export const RECENTLY_CONNECTED_DAYS = 90;

/** Nothing in this long makes a relationship dormant. */
export const DORMANT_MONTHS = 12;

/**
 * The cut for "high value" in the dormant list.
 *
 * WHICH SIGNAL, AND WHY: `Connection.relationshipScore`, the column the Phase 6
 * scoring run materializes — not `ProspectMatch`.
 *
 *   - It is already materialized, so the threshold is an indexed predicate
 *     (`@@index([importBatchId, relationshipScore])`) rather than a read-time
 *     computation over every message in the batch.
 *   - It is the number every other surface displays for this person, so this
 *     list cannot contradict the prospect table sitting next to it.
 *   - It measures the RELATIONSHIP (message volume, reply ratio, recency,
 *     thread structure), which is what "high-value relationship" means here.
 *
 * `ProspectMatch` was considered and deliberately rejected as the gate: it
 * scores commercial FIT against an org-defined ICP, not the strength of the
 * relationship, and it is empty for every connection until an admin defines an
 * ICP — so gating on it would make this list silently vanish for most orgs.
 *
 * NULL is not zero: an unscored connection is unknown, never "low value", and
 * is excluded rather than ranked last. When nothing at all has been scored the
 * card says the scoring run has not reached this batch yet.
 */
export const HIGH_VALUE_SCORE = 70;

/** A person on an action list, already resolved to a linkable connection. */
export type ActionPerson = {
  /**
   * The CONNECTION's `identityKey` — what `prospectHref` expects. Null when the
   * counterparty on a message thread matched no connection in this batch, in
   * which case there is no prospect page to link to and the name renders plain.
   */
  identityKey: string | null;
  name: string;
  company: string | null;
  /** Their job title from the export. Null when they left it blank. */
  position: string | null;
};

export type AwaitingReplyItem = ActionPerson & {
  /** When they last wrote to you. Never null — the query requires it. */
  lastInboundAt: Date;
};

export type NeverMessagedItem = ActionPerson & {
  connectedOn: Date;
};

export type DormantItem = ActionPerson & {
  lastMessageAt: Date;
  relationshipScore: number;
};

export type ActionList<T> = {
  items: T[];
  /** Total matching rows, of which `items` is the first `ACTION_LIST_LIMIT`. */
  total: number;
};

export type DormantList = ActionList<DormantItem> & {
  /**
   * How many connections in this batch carry a materialized score at all. Zero
   * means the scoring run has not reached this batch — an explicit "not yet
   * known" state, not "no dormant relationships".
   */
  scoredConnections: number;
};

function displayName(
  firstName: string | null,
  lastName: string | null,
  fallback: string | null,
): string {
  const joined = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (joined) return joined;
  const trimmed = (fallback ?? "").trim();
  return trimmed || "Unnamed contact";
}

/**
 * 1. YOU OWE THEM A REPLY.
 *
 * Conversations whose most recent message came from the other person.
 *
 * QUERY: `DISTINCT ON (conversationId) ... ORDER BY conversationId, sentAt DESC`
 * is the latest message per conversation in one pass — Prisma's `groupBy`
 * cannot express "the whole row at the max", only the max itself, which is why
 * this one is raw. The result is filtered to inbound, `COUNT(*) OVER ()` gives
 * the full backlog size before the LIMIT, and only the rendered rows are
 * joined back to `Connection` for a name and a prospect link.
 *
 * DIRECTION-UNKNOWN MESSAGES (`senderIsUser IS NULL` — group threads where
 * ingestion could not identify the sender) are kept in the DISTINCT ON but
 * never claimed. Dropping them first would promote the previous message to
 * "latest" and could assert that you owe a reply when in fact the last thing
 * said in the thread may have been yours. Instead such a conversation lands in
 * neither bucket and is counted in `unknownLatest`, which the card states.
 *
 * COST: one index scan of `MessageRecord` on `importBatchId` (~18.6k rows for a
 * full export) plus a sort on `(conversationId, sentAt)`. Both fit in work_mem
 * comfortably; a covering `(importBatchId, conversationId, sentAt DESC)` index
 * would turn the sort into an ordered index scan but is not worth a migration
 * at this row count.
 */
export async function loadAwaitingReply(
  importBatchId: string,
): Promise<ActionList<AwaitingReplyItem> & { unknownLatest: number }> {
  const rows = await prisma.$queryRaw<
    {
      // Null on the single placeholder row returned when nothing is owed —
      // the tallies still have to come back so the card can state how many
      // conversations were set aside as direction-unknown.
      identityKey: string | null;
      nameKey: string | null;
      counterpartyName: string | null;
      lastInboundAt: Date | null;
      total: number;
      unknownLatest: number;
    }[]
  >`
    WITH latest AS (
      SELECT DISTINCT ON (m."conversationId")
        m."identityKey"      AS "identityKey",
        m."nameKey"          AS "nameKey",
        m."counterpartyName" AS "counterpartyName",
        m."senderIsUser"     AS "senderIsUser",
        m."sentAt"           AS "sentAt"
      FROM "MessageRecord" m
      WHERE m."importBatchId" = ${importBatchId}
        AND m."conversationId" IS NOT NULL
        AND m."sentAt" IS NOT NULL
      ORDER BY m."conversationId", m."sentAt" DESC, m."id" DESC
    ),
    tallies AS (
      SELECT (COUNT(*) FILTER (WHERE "senderIsUser" = false))::int AS total,
             (COUNT(*) FILTER (WHERE "senderIsUser" IS NULL))::int AS "unknownLatest"
      FROM latest
    )
    SELECT l."identityKey", l."nameKey", l."counterpartyName",
           l."sentAt" AS "lastInboundAt",
           t.total, t."unknownLatest"
    FROM tallies t
    LEFT JOIN LATERAL (
      SELECT "identityKey", "nameKey", "counterpartyName", "sentAt"
      FROM latest
      WHERE "senderIsUser" = false
      ORDER BY "sentAt" ASC
      LIMIT ${ACTION_LIST_LIMIT}
    ) l ON true
  `;

  // The LEFT JOIN LATERAL guarantees one row even when nothing is owed; that
  // row carries the tallies and no person.
  const people = rows.filter(
    (row): row is typeof row & { identityKey: string; lastInboundAt: Date } =>
      row.identityKey !== null && row.lastInboundAt !== null,
  );
  const connections = await resolveConnections(importBatchId, people);

  return {
    total: rows[0]?.total ?? 0,
    unknownLatest: rows[0]?.unknownLatest ?? 0,
    items: people.map((row) => {
      const connection = connections.resolve(row);
      return {
        identityKey: connection?.identityKey ?? null,
        name: displayName(
          connection?.firstName ?? null,
          connection?.lastName ?? null,
          row.counterpartyName,
        ),
        company: connection?.company ?? null,
        position: connection?.position ?? null,
        lastInboundAt: row.lastInboundAt,
      };
    }),
  };
}

/**
 * 2. RECENTLY CONNECTED, NEVER MESSAGED.
 *
 * QUERY: the set of counterparty keys that appear anywhere in this batch's
 * messages is built ONCE (a `UNION` of the distinct `identityKey`s and the
 * distinct `nameKey`s — a few thousand keys), then anti-joined against the
 * connections accepted in the window. Written as a correlated `NOT EXISTS`
 * over `MessageRecord` with an `OR` across the two keys instead, the planner
 * would have to re-probe the message table per candidate; materializing the key
 * set makes the cost a single pass over messages plus one hash anti-join,
 * regardless of how many people accepted recently.
 *
 * `connectedOn` is nullable in the export, and a null date cannot be placed in
 * a 90-day window — those rows are not silently treated as old, they are simply
 * not claimed either way.
 *
 * COST: one index scan of `MessageRecord` on `importBatchId` + hash aggregate,
 * one index scan of `Connection` on `importBatchId` (~5.6k rows), one hash
 * anti-join. No index needed beyond the two that exist.
 */
export async function loadRecentlyConnectedNeverMessaged(
  importBatchId: string,
  now: Date = new Date(),
): Promise<ActionList<NeverMessagedItem>> {
  const since = new Date(now.getTime() - RECENTLY_CONNECTED_DAYS * 86_400_000);

  const rows = await prisma.$queryRaw<
    {
      identityKey: string;
      firstName: string | null;
      lastName: string | null;
      company: string | null;
      position: string | null;
      connectedOn: Date;
      total: number;
    }[]
  >`
    WITH messaged AS (
      SELECT DISTINCT "identityKey" AS k
      FROM "MessageRecord"
      WHERE "importBatchId" = ${importBatchId}
      UNION
      SELECT DISTINCT "nameKey" AS k
      FROM "MessageRecord"
      WHERE "importBatchId" = ${importBatchId} AND "nameKey" IS NOT NULL
    )
    SELECT c."identityKey" AS "identityKey",
           c."firstName"   AS "firstName",
           c."lastName"    AS "lastName",
           c."company"      AS "company",
           c."position"     AS "position",
           c."connectedOn" AS "connectedOn",
           (COUNT(*) OVER ())::int AS total
    FROM "Connection" c
    WHERE c."importBatchId" = ${importBatchId}
      AND c."connectedOn" IS NOT NULL
      AND c."connectedOn" >= ${since}
      AND NOT EXISTS (SELECT 1 FROM messaged m WHERE m.k = c."identityKey")
      AND (c."nameKey" IS NULL OR NOT EXISTS (SELECT 1 FROM messaged m WHERE m.k = c."nameKey"))
    ORDER BY c."connectedOn" DESC
    LIMIT ${ACTION_LIST_LIMIT}
  `;

  return {
    total: rows[0]?.total ?? 0,
    items: rows.map((row) => ({
      identityKey: row.identityKey,
      name: displayName(row.firstName, row.lastName, null),
      company: row.company,
      position: row.position,
      connectedOn: row.connectedOn,
    })),
  };
}

/**
 * 3. DORMANT HIGH-VALUE RELATIONSHIPS.
 *
 * Real message history, nothing for 12+ months, and a materialized
 * relationship score at or above `HIGH_VALUE_SCORE` — see that constant for
 * why that signal and not `ProspectMatch`.
 *
 * QUERY: last-message-per-key is a grouped aggregate over the batch's messages
 * on each of the two join keys; a connection takes `GREATEST` of its two
 * matches (Postgres `GREATEST` ignores NULLs, so a connection that only joins
 * on one key still gets a date). The score predicate rides the existing
 * `@@index([importBatchId, relationshipScore])`.
 *
 * COST: one pass over `MessageRecord` for the batch with two hash aggregates,
 * one index scan of `Connection`, two hash joins. Nothing scales with the
 * number of rows rendered.
 */
export async function loadDormantHighValue(
  importBatchId: string,
  now: Date = new Date(),
): Promise<DormantList> {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - DORMANT_MONTHS);

  const [rows, scoredConnections] = await Promise.all([
    prisma.$queryRaw<
      {
        identityKey: string;
        firstName: string | null;
        lastName: string | null;
        company: string | null;
        position: string | null;
        relationshipScore: number;
        lastMessageAt: Date;
        total: number;
      }[]
    >`
      WITH last_seen AS (
        SELECT "identityKey" AS k, MAX("sentAt") AS "lastAt"
        FROM "MessageRecord"
        WHERE "importBatchId" = ${importBatchId} AND "sentAt" IS NOT NULL
        GROUP BY "identityKey"
        UNION ALL
        SELECT "nameKey" AS k, MAX("sentAt") AS "lastAt"
        FROM "MessageRecord"
        WHERE "importBatchId" = ${importBatchId} AND "sentAt" IS NOT NULL AND "nameKey" IS NOT NULL
        GROUP BY "nameKey"
      ),
      agg AS (
        SELECT k, MAX("lastAt") AS "lastAt" FROM last_seen GROUP BY k
      ),
      candidates AS (
        SELECT c."identityKey" AS "identityKey",
               c."firstName"   AS "firstName",
               c."lastName"    AS "lastName",
               c."company"      AS "company",
               c."position"     AS "position",
               c."relationshipScore" AS "relationshipScore",
               GREATEST(byIdentity."lastAt", byName."lastAt") AS "lastMessageAt"
        FROM "Connection" c
        LEFT JOIN agg byIdentity ON byIdentity.k = c."identityKey"
        LEFT JOIN agg byName ON c."nameKey" IS NOT NULL AND byName.k = c."nameKey"
        WHERE c."importBatchId" = ${importBatchId}
          AND c."relationshipScore" >= ${HIGH_VALUE_SCORE}
      )
      SELECT "identityKey", "firstName", "lastName", "company", "position", "relationshipScore", "lastMessageAt",
             (COUNT(*) OVER ())::int AS total
      FROM candidates
      WHERE "lastMessageAt" IS NOT NULL
        AND "lastMessageAt" < ${cutoff}
      ORDER BY "relationshipScore" DESC, "lastMessageAt" ASC
      LIMIT ${ACTION_LIST_LIMIT}
    `,
    prisma.connection.count({
      where: { importBatchId, relationshipScore: { not: null } },
    }),
  ]);

  return {
    scoredConnections,
    total: rows[0]?.total ?? 0,
    items: rows.map((row) => ({
      identityKey: row.identityKey,
      name: displayName(row.firstName, row.lastName, null),
      company: row.company,
      position: row.position,
      lastMessageAt: row.lastMessageAt,
      relationshipScore: row.relationshipScore,
    })),
  };
}

type ResolvedConnection = {
  identityKey: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  position: string | null;
};

/**
 * Looks up the `Connection` rows behind a handful of counterparty keys, so a
 * message thread can be given a name and a prospect link.
 *
 * Called with the RENDERED rows only (at most `ACTION_LIST_LIMIT`), so this is
 * one indexed query over a short IN list — the same shape `loadInteractionSignals`
 * uses. Exact `identityKey` wins over the `nameKey` fallback, and when two
 * connections share a display name the first is used rather than both, because
 * the export gives no way to tell them apart.
 */
async function resolveConnections(
  importBatchId: string,
  rows: { identityKey: string; nameKey: string | null }[],
) {
  const identityKeys = [...new Set(rows.map((row) => row.identityKey))];
  const nameKeys = [...new Set(rows.map((row) => row.nameKey).filter((key): key is string => !!key))];

  const matches =
    identityKeys.length === 0 && nameKeys.length === 0
      ? []
      : await prisma.connection.findMany({
          where: {
            importBatchId,
            OR: [{ identityKey: { in: identityKeys } }, { nameKey: { in: nameKeys } }],
          },
          select: {
            identityKey: true,
            nameKey: true,
            firstName: true,
            lastName: true,
            company: true,
            position: true,
          },
        });

  const byIdentity = new Map<string, ResolvedConnection>();
  const byName = new Map<string, ResolvedConnection>();
  for (const match of matches) {
    const value: ResolvedConnection = {
      identityKey: match.identityKey,
      firstName: match.firstName,
      lastName: match.lastName,
      company: match.company,
      position: match.position,
    };
    if (!byIdentity.has(match.identityKey)) byIdentity.set(match.identityKey, value);
    if (match.nameKey && !byName.has(match.nameKey)) byName.set(match.nameKey, value);
  }

  return {
    resolve(row: { identityKey: string; nameKey: string | null }): ResolvedConnection | null {
      return (
        byIdentity.get(row.identityKey) ?? (row.nameKey ? byName.get(row.nameKey) ?? null : null)
      );
    },
  };
}
