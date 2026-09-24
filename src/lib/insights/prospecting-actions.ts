import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { connectionSearchSql } from "@/lib/insights/prospects";
import {
  excludeNotUsefulSql,
  joinUserMarksSql,
  USEFULNESS_RANK_SELECT,
  usefulnessFirstByColumn,
  userMarksSql,
} from "@/lib/insights/mark-order";
import type { ProspectSortKey } from "@/components/prospect-table";

/**
 * The three "do this next" action lists.
 *
 * Each list has ONE definition, expressed once as a SQL fragment
 * (`awaitingReplySql`, `neverMessagedSql`, `dormantSql`). The dashboard card
 * and the list's full page both read that fragment — the card takes the first
 * `ACTION_LIST_LIMIT` rows, the page pages through all of them — so the two
 * surfaces cannot disagree about who is on a list. Adding a condition in one
 * place changes both.
 *
 * WHY THIS IS ALL SQL
 * -------------------
 * A real export is ~18,650 messages and ~5,580 connections, and the dashboard
 * is server-rendered on every visit. Pulling message rows into JS to reduce
 * them (the shape `loadInteractionSignals` uses, which is correct for the tens
 * of rows on one prospect page) would move megabytes over the wire on every
 * page load. Every aggregate below is computed in Postgres and only the rows
 * actually rendered come back.
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

/** Rows rendered per action list ON THE DASHBOARD. The rest is reported as a count. */
export const ACTION_LIST_LIMIT = 6;

/** Rows per page on the full action pages. Matches `/connections`. */
export const ACTION_PAGE_SIZE = 25;

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

/* ------------------------------------------------------------------------ *
 * SHARED PIECES
 * ------------------------------------------------------------------------ */

/**
 * The batch's connections, deduplicated on each join key.
 *
 * `DISTINCT ON` rather than a plain scan because `nameKey` is not unique: two
 * people with the same display name share one, and joining a message thread to
 * both would double the row. The first by id wins, which is the same
 * first-wins rule the old in-memory resolver used — the export gives no way to
 * tell the two apart, so inventing a second row would be a fabrication.
 */
function connectionPoolSql(importBatchId: string): Prisma.Sql {
  return Prisma.sql`
    conns AS (
      SELECT "id", "identityKey", "nameKey", "firstName", "lastName", "company",
             "position", "connectedOn", "relationshipScore"
      FROM "Connection"
      WHERE "importBatchId" = ${importBatchId}
    ),
    conns_by_identity AS (
      SELECT DISTINCT ON ("identityKey") * FROM conns ORDER BY "identityKey", "id"
    ),
    conns_by_name AS (
      SELECT DISTINCT ON ("nameKey") * FROM conns
      WHERE "nameKey" IS NOT NULL
      ORDER BY "nameKey", "id"
    )
  `;
}

/** The set of counterparty keys this batch has any message with. */
function messagedKeysSql(importBatchId: string): Prisma.Sql {
  return Prisma.sql`
    messaged AS (
      SELECT DISTINCT "identityKey" AS k
      FROM "MessageRecord"
      WHERE "importBatchId" = ${importBatchId}
      UNION
      SELECT DISTINCT "nameKey" AS k
      FROM "MessageRecord"
      WHERE "importBatchId" = ${importBatchId} AND "nameKey" IS NOT NULL
    )
  `;
}

/**
 * ORDER BY clauses the action pages accept, keyed by validated sort key.
 *
 * `direction` is the reader's, but for the two time dimensions DESC means
 * "most urgent first" — longest waiting, longest dormant — which is the
 * OLDEST date. The header reads "Waiting" and "Last spoke", so a descending
 * arrow meaning "most of it" is what a reader expects; it is inverted here
 * rather than in the UI so the SQL is the single place that decides.
 *
 * Every clause ends on the connection id, so paging is stable when the
 * dimension ties.
 */
const ACTION_ORDER_BY: Partial<Record<ProspectSortKey, (desc: boolean) => string>> = {
  name: (desc) =>
    `"firstName" ${dir(desc)} NULLS LAST, "lastName" ${dir(desc)} NULLS LAST`,
  company: (desc) => `"company" ${dir(desc)} NULLS LAST, "lastName" ASC`,
  connectedOn: (desc) => `"connectedOn" ${dir(desc)} NULLS LAST, "lastName" ASC`,
  // NULLS LAST in both directions: unscored is unknown, not weak.
  strength: (desc) => `"relationshipScore" ${dir(desc)} NULLS LAST, "lastName" ASC`,
  waiting: (desc) => `"lastInboundAt" ${dir(!desc)}`,
  lastMessage: (desc) => `"lastMessageAt" ${dir(!desc)}`,
};

function dir(desc: boolean) {
  return desc ? "DESC" : "ASC";
}

function orderBySql(sort: ProspectSortKey, direction: "asc" | "desc"): Prisma.Sql {
  const clause = ACTION_ORDER_BY[sort];
  if (!clause) {
    // Unreachable in practice: the page validates `?sort=` against its own
    // allow-list before calling. Falling back to a stable order rather than
    // throwing keeps a hand-edited URL from 500ing.
    return usefulnessFirstByColumn(`"connectionId" ASC`);
  }
  // `Prisma.raw` over a literal from the table above, selected by an
  // already-validated key — never over anything from the query string.
  return usefulnessFirstByColumn(`${clause(direction === "desc")}, "connectionId" ASC`);
}

/** One page of an action list: the connection ids to render, in order. */
export type ActionPage = {
  ids: string[];
  total: number;
  page: number;
  /** The list's own dimension, per connection id, for the extra column. */
  extra: Map<string, { at: Date; relationshipScore: number | null }>;
  /**
   * Rows in the population that matched no connection in this import, so the
   * table has no row to show for them. Always 0 for the two connection-based
   * lists; the reply list surfaces it rather than quietly shrinking its total.
   */
  unlinked: number;
};

type RawPageRow = {
  connectionId: string | null;
  at: Date | null;
  relationshipScore: number | null;
  total: number;
  unlinked: number;
};

/**
 * Runs a paged action query, clamping the requested page to what exists.
 *
 * The total is only known once the query has run, so an out-of-range `?page=`
 * costs one extra round trip rather than a pre-count on every request — the
 * common case is page 1 and a single query.
 */
async function runActionPage(
  run: (limit: number, offset: number) => Promise<RawPageRow[]>,
  page: number,
  pageSize: number,
): Promise<ActionPage> {
  const requested = Math.max(1, page);
  let rows = await run(pageSize, (requested - 1) * pageSize);
  const total = rows[0]?.total ?? 0;
  const unlinked = rows[0]?.unlinked ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(requested, totalPages);

  if (safePage !== requested && total > 0) {
    rows = await run(pageSize, (safePage - 1) * pageSize);
  }

  const extra = new Map<string, { at: Date; relationshipScore: number | null }>();
  const ids: string[] = [];
  for (const row of rows) {
    // The LEFT JOIN LATERAL below guarantees one row even when the page is
    // empty; that row carries the tallies and no person.
    if (!row.connectionId || !row.at) continue;
    ids.push(row.connectionId);
    extra.set(row.connectionId, { at: row.at, relationshipScore: row.relationshipScore });
  }

  return { ids, total, page: safePage, extra, unlinked };
}

/* ------------------------------------------------------------------------ *
 * 1. YOU OWE THEM A REPLY
 * ------------------------------------------------------------------------ */

/**
 * Conversations whose most recent message came from the other person, joined
 * to the connection behind that counterparty.
 *
 * QUERY: `DISTINCT ON (conversationId) ... ORDER BY conversationId, sentAt DESC`
 * is the latest message per conversation in one pass — Prisma's `groupBy`
 * cannot express "the whole row at the max", only the max itself, which is why
 * this one is raw.
 *
 * DIRECTION-UNKNOWN MESSAGES (`senderIsUser IS NULL` — group threads where
 * ingestion could not identify the sender) are kept in the DISTINCT ON but
 * never claimed. Dropping them first would promote the previous message to
 * "latest" and could assert that you owe a reply when in fact the last thing
 * said in the thread may have been yours. Instead such a conversation lands in
 * neither bucket and is counted in `unknownLatest`, which both surfaces state.
 *
 * The connection join is two LEFT JOINs against the deduplicated pool rather
 * than a correlated lookup per thread: one hash join over ~5.6k connections,
 * not one index probe per owed conversation. Identity beats name, via COALESCE.
 *
 * COST: one index scan of `MessageRecord` on `@@index([importBatchId])`
 * (~18.6k rows) plus a sort on `(conversationId, sentAt)`; one index scan of
 * `Connection` on `@@index([importBatchId])` plus two sorts for the DISTINCT
 * ONs; two hash joins. All fit in work_mem comfortably at this row count. A
 * covering `(importBatchId, conversationId, sentAt DESC)` index would turn the
 * message sort into an ordered index scan but is not worth a migration here.
 */
function awaitingReplySql(importBatchId: string, userId: string): Prisma.Sql {
  return Prisma.sql`
    ${connectionPoolSql(importBatchId)},
    latest AS (
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
    owed AS (
      SELECT
        COALESCE(ci."id", cn."id")                               AS "connectionId",
        COALESCE(ci."identityKey", cn."identityKey")             AS "connectionIdentityKey",
        COALESCE(ci."firstName", cn."firstName")                 AS "firstName",
        COALESCE(ci."lastName", cn."lastName")                   AS "lastName",
        COALESCE(ci."company", cn."company")                     AS "company",
        COALESCE(ci."position", cn."position")                   AS "position",
        COALESCE(ci."connectedOn", cn."connectedOn")             AS "connectedOn",
        COALESCE(ci."relationshipScore", cn."relationshipScore")  AS "relationshipScore",
        l."counterpartyName"                                     AS "counterpartyName",
        l."sentAt"                                               AS "lastInboundAt"
      FROM latest l
      LEFT JOIN conns_by_identity ci ON ci."identityKey" = l."identityKey"
      LEFT JOIN conns_by_name cn ON l."nameKey" IS NOT NULL AND cn."nameKey" = l."nameKey"
      WHERE l."senderIsUser" = false
        ${excludeNotUsefulSql(`COALESCE(ci."identityKey", cn."identityKey")`, userId)}
    )
  `;
}

/** The dashboard card: the longest-waiting few, plus the tallies. */
export async function loadAwaitingReply(
  importBatchId: string,
  userId: string,
): Promise<ActionList<AwaitingReplyItem> & { unknownLatest: number }> {
  const rows = await prisma.$queryRaw<
    {
      // Null on the single placeholder row returned when nothing is owed —
      // the tallies still have to come back so the card can state how many
      // conversations were set aside as direction-unknown.
      connectionIdentityKey: string | null;
      firstName: string | null;
      lastName: string | null;
      company: string | null;
      position: string | null;
      counterpartyName: string | null;
      lastInboundAt: Date | null;
      total: number;
      unknownLatest: number;
    }[]
  >(Prisma.sql`
    WITH ${awaitingReplySql(importBatchId, userId)},
    tallies AS (
      SELECT (SELECT COUNT(*) FROM owed)::int AS total,
             (SELECT COUNT(*) FROM latest WHERE "senderIsUser" IS NULL)::int AS "unknownLatest"
    )
    SELECT o."connectionIdentityKey", o."firstName", o."lastName", o."company",
           o."position", o."counterpartyName", o."lastInboundAt",
           t.total, t."unknownLatest"
    FROM tallies t
    LEFT JOIN LATERAL (
      SELECT * FROM owed ORDER BY "lastInboundAt" ASC, "connectionId" ASC
      LIMIT ${ACTION_LIST_LIMIT}
    ) o ON true
  `);

  return {
    total: rows[0]?.total ?? 0,
    unknownLatest: rows[0]?.unknownLatest ?? 0,
    items: rows
      .filter((row): row is typeof row & { lastInboundAt: Date } => row.lastInboundAt !== null)
      .map((row) => ({
        identityKey: row.connectionIdentityKey,
        name: displayName(row.firstName, row.lastName, row.counterpartyName),
        company: row.company,
        position: row.position,
        lastInboundAt: row.lastInboundAt,
      })),
  };
}

/**
 * The full page: the same population, paged and searchable.
 *
 * Restricted to owed conversations that resolved to a connection, because the
 * page renders the shared connection table and a thread with no connection has
 * no row, no status and no relationship strength to show. How many were left
 * out comes back as `unlinked` and the page says so rather than presenting a
 * quietly smaller number than the dashboard card.
 */
export async function fetchAwaitingReplyPage({
  userId,
  importBatchId,
  page,
  sort,
  direction,
  query,
  pageSize = ACTION_PAGE_SIZE,
}: {
  /**
   * The VIEWER. Only used to join their own Usefulness marks, which lead every
   * ordering — never another member's, which would sort this list by a
   * judgement the reader never made.
   */
  userId: string;
  importBatchId: string;
  page: number;
  sort: ProspectSortKey;
  direction: "asc" | "desc";
  query: string;
  pageSize?: number;
}): Promise<ActionPage> {
  return runActionPage(
    (limit, offset) =>
      prisma.$queryRaw<RawPageRow[]>(Prisma.sql`
        WITH ${userMarksSql(userId)},
        ${awaitingReplySql(importBatchId, userId)},
        filtered AS (
          SELECT o.*, ${Prisma.raw(USEFULNESS_RANK_SELECT)}
          FROM owed o
          ${joinUserMarksSql(`o."connectionIdentityKey"`)}
          WHERE o."connectionId" IS NOT NULL ${connectionSearchSql(query, "o")}
        ),
        unlinked AS (
          SELECT COUNT(*)::int AS n FROM owed o
          WHERE o."connectionId" IS NULL ${connectionSearchSql(query, "o")}
        ),
        tallies AS (
          SELECT (SELECT COUNT(*) FROM filtered)::int AS total,
                 (SELECT n FROM unlinked) AS unlinked
        )
        SELECT p."connectionId", p."lastInboundAt" AS "at", p."relationshipScore",
               t.total, t.unlinked
        FROM tallies t
        LEFT JOIN LATERAL (
          SELECT * FROM filtered ORDER BY ${orderBySql(sort, direction)}
          LIMIT ${limit} OFFSET ${offset}
        ) p ON true
      `),
    page,
    pageSize,
  );
}

/* ------------------------------------------------------------------------ *
 * 2. RECENTLY CONNECTED, NEVER MESSAGED
 * ------------------------------------------------------------------------ */

/**
 * Connections accepted inside the window with no message either way.
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
 * COST: one index scan of `MessageRecord` on `@@index([importBatchId])` + hash
 * aggregate; one index scan of `Connection` on `@@index([importBatchId])`
 * (~5.6k rows); one hash anti-join. No index needed beyond the two that exist.
 */
function neverMessagedSql(importBatchId: string, since: Date, userId: string): Prisma.Sql {
  return Prisma.sql`
    ${messagedKeysSql(importBatchId)},
    candidates AS (
      SELECT c."id"                AS "connectionId",
             c."identityKey"       AS "connectionIdentityKey",
             c."firstName"         AS "firstName",
             c."lastName"          AS "lastName",
             c."company"           AS "company",
             c."position"          AS "position",
             c."connectedOn"       AS "connectedOn",
             c."relationshipScore" AS "relationshipScore"
      FROM "Connection" c
      WHERE c."importBatchId" = ${importBatchId}
        AND c."connectedOn" IS NOT NULL
        AND c."connectedOn" >= ${since}
        AND NOT EXISTS (SELECT 1 FROM messaged m WHERE m.k = c."identityKey")
        AND (c."nameKey" IS NULL OR NOT EXISTS (SELECT 1 FROM messaged m WHERE m.k = c."nameKey"))
        ${excludeNotUsefulSql(`c."identityKey"`, userId)}
    )
  `;
}

/** The window start, so the card and the page cut at the same instant's worth of days. */
function recentlyConnectedSince(now: Date): Date {
  return new Date(now.getTime() - RECENTLY_CONNECTED_DAYS * 86_400_000);
}

export async function loadRecentlyConnectedNeverMessaged(
  importBatchId: string,
  userId: string,
  now: Date = new Date(),
): Promise<ActionList<NeverMessagedItem>> {
  const rows = await prisma.$queryRaw<
    {
      connectionIdentityKey: string;
      firstName: string | null;
      lastName: string | null;
      company: string | null;
      position: string | null;
      connectedOn: Date;
      total: number;
    }[]
  >(Prisma.sql`
    WITH ${neverMessagedSql(importBatchId, recentlyConnectedSince(now), userId)}
    SELECT "connectionIdentityKey", "firstName", "lastName", "company", "position",
           "connectedOn", (COUNT(*) OVER ())::int AS total
    FROM candidates
    ORDER BY "connectedOn" DESC, "connectionId" ASC
    LIMIT ${ACTION_LIST_LIMIT}
  `);

  return {
    total: rows[0]?.total ?? 0,
    items: rows.map((row) => ({
      identityKey: row.connectionIdentityKey,
      name: displayName(row.firstName, row.lastName, null),
      company: row.company,
      position: row.position,
      connectedOn: row.connectedOn,
    })),
  };
}

export async function fetchNeverMessagedPage({
  userId,
  importBatchId,
  page,
  sort,
  direction,
  query,
  now = new Date(),
  pageSize = ACTION_PAGE_SIZE,
}: {
  /** The VIEWER. See `fetchAwaitingReplyPage`. */
  userId: string;
  importBatchId: string;
  page: number;
  sort: ProspectSortKey;
  direction: "asc" | "desc";
  query: string;
  now?: Date;
  pageSize?: number;
}): Promise<ActionPage> {
  const since = recentlyConnectedSince(now);
  return runActionPage(
    (limit, offset) =>
      prisma.$queryRaw<RawPageRow[]>(Prisma.sql`
        WITH ${userMarksSql(userId)},
        ${neverMessagedSql(importBatchId, since, userId)},
        filtered AS (
          SELECT c.*, ${Prisma.raw(USEFULNESS_RANK_SELECT)}
          FROM candidates c
          ${joinUserMarksSql(`c."connectionIdentityKey"`)}
          WHERE TRUE ${connectionSearchSql(query, "c")}
        ),
        tallies AS (
          SELECT (SELECT COUNT(*) FROM filtered)::int AS total, 0 AS unlinked
        )
        SELECT p."connectionId", p."connectedOn" AS "at", p."relationshipScore",
               t.total, t.unlinked
        FROM tallies t
        LEFT JOIN LATERAL (
          SELECT * FROM filtered ORDER BY ${orderBySql(sort, direction)}
          LIMIT ${limit} OFFSET ${offset}
        ) p ON true
      `),
    page,
    pageSize,
  );
}

/* ------------------------------------------------------------------------ *
 * 3. DORMANT HIGH-VALUE RELATIONSHIPS
 * ------------------------------------------------------------------------ */

/**
 * Real message history, nothing for `DORMANT_MONTHS`+ months, and a
 * materialized relationship score at or above `HIGH_VALUE_SCORE` — see that
 * constant for why that signal and not `ProspectMatch`.
 *
 * QUERY: last-message-per-key is a grouped aggregate over the batch's messages
 * on each of the two join keys; a connection takes `GREATEST` of its two
 * matches (Postgres `GREATEST` ignores NULLs, so a connection that only joins
 * on one key still gets a date). The score predicate rides the existing
 * `@@index([importBatchId, relationshipScore])`.
 *
 * COST: one pass over `MessageRecord` for the batch with two hash aggregates,
 * one index scan of `Connection` on `@@index([importBatchId, relationshipScore])`,
 * two hash joins. Nothing scales with the number of rows rendered.
 */
function dormantSql(importBatchId: string, cutoff: Date, userId: string): Prisma.Sql {
  return Prisma.sql`
    last_seen AS (
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
    scored AS (
      SELECT c."id"                AS "connectionId",
             c."identityKey"       AS "connectionIdentityKey",
             c."firstName"         AS "firstName",
             c."lastName"          AS "lastName",
             c."company"           AS "company",
             c."position"          AS "position",
             c."connectedOn"       AS "connectedOn",
             c."relationshipScore" AS "relationshipScore",
             GREATEST(byIdentity."lastAt", byName."lastAt") AS "lastMessageAt"
      FROM "Connection" c
      LEFT JOIN agg byIdentity ON byIdentity.k = c."identityKey"
      LEFT JOIN agg byName ON c."nameKey" IS NOT NULL AND byName.k = c."nameKey"
      WHERE c."importBatchId" = ${importBatchId}
        AND c."relationshipScore" >= ${HIGH_VALUE_SCORE}
        ${excludeNotUsefulSql(`c."identityKey"`, userId)}
    ),
    candidates AS (
      SELECT * FROM scored
      WHERE "lastMessageAt" IS NOT NULL AND "lastMessageAt" < ${cutoff}
    )
  `;
}

function dormantCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - DORMANT_MONTHS);
  return cutoff;
}

export async function loadDormantHighValue(
  importBatchId: string,
  userId: string,
  now: Date = new Date(),
): Promise<DormantList> {
  const [rows, scoredConnections] = await Promise.all([
    prisma.$queryRaw<
      {
        connectionIdentityKey: string;
        firstName: string | null;
        lastName: string | null;
        company: string | null;
        position: string | null;
        relationshipScore: number;
        lastMessageAt: Date;
        total: number;
      }[]
    >(Prisma.sql`
      WITH ${dormantSql(importBatchId, dormantCutoff(now), userId)}
      SELECT "connectionIdentityKey", "firstName", "lastName", "company", "position",
             "relationshipScore", "lastMessageAt", (COUNT(*) OVER ())::int AS total
      FROM candidates
      ORDER BY "relationshipScore" DESC, "lastMessageAt" ASC, "connectionId" ASC
      LIMIT ${ACTION_LIST_LIMIT}
    `),
    prisma.connection.count({
      where: { importBatchId, relationshipScore: { not: null } },
    }),
  ]);

  return {
    scoredConnections,
    total: rows[0]?.total ?? 0,
    items: rows.map((row) => ({
      identityKey: row.connectionIdentityKey,
      name: displayName(row.firstName, row.lastName, null),
      company: row.company,
      position: row.position,
      lastMessageAt: row.lastMessageAt,
      relationshipScore: row.relationshipScore,
    })),
  };
}

export async function fetchDormantPage({
  userId,
  importBatchId,
  page,
  sort,
  direction,
  query,
  now = new Date(),
  pageSize = ACTION_PAGE_SIZE,
}: {
  /** The VIEWER. See `fetchAwaitingReplyPage`. */
  userId: string;
  importBatchId: string;
  page: number;
  sort: ProspectSortKey;
  direction: "asc" | "desc";
  query: string;
  now?: Date;
  pageSize?: number;
}): Promise<ActionPage> {
  const cutoff = dormantCutoff(now);
  return runActionPage(
    (limit, offset) =>
      prisma.$queryRaw<RawPageRow[]>(Prisma.sql`
        WITH ${userMarksSql(userId)},
        ${dormantSql(importBatchId, cutoff, userId)},
        filtered AS (
          SELECT c.*, ${Prisma.raw(USEFULNESS_RANK_SELECT)}
          FROM candidates c
          ${joinUserMarksSql(`c."connectionIdentityKey"`)}
          WHERE TRUE ${connectionSearchSql(query, "c")}
        ),
        tallies AS (
          SELECT (SELECT COUNT(*) FROM filtered)::int AS total, 0 AS unlinked
        )
        SELECT p."connectionId", p."lastMessageAt" AS "at", p."relationshipScore",
               t.total, t.unlinked
        FROM tallies t
        LEFT JOIN LATERAL (
          SELECT * FROM filtered ORDER BY ${orderBySql(sort, direction)}
          LIMIT ${limit} OFFSET ${offset}
        ) p ON true
      `),
    page,
    pageSize,
  );
}

/** How many connections in this batch carry a materialized score at all. */
export function countScoredConnections(importBatchId: string): Promise<number> {
  return prisma.connection.count({
    where: { importBatchId, relationshipScore: { not: null } },
  });
}
