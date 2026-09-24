import "server-only";

import { Prisma } from "@prisma/client";

/**
 * USEFULNESS IS THE PRIMARY SORT KEY ON EVERY LIST OF PEOPLE.
 *
 * The product rule: thumbs-up first, unmarked next, thumbs-down last — and
 * whatever column the reader clicked orders WITHIN those three bands, never
 * across them. A person you marked "not useful" must never appear above an
 * unmarked one, whatever the view or the header.
 *
 * WHY THIS IS RAW SQL RATHER THAN A PRISMA `orderBy`
 * --------------------------------------------------
 * `ConnectionMark` is keyed by `(userId, identityKey)` and has NO relation to
 * `Connection` — the two join on the `identityKey` string, deliberately, so a
 * mark outlives the connection rows that come and go with each import (see the
 * schema note). Prisma cannot order by a column it cannot reach through a
 * relation, so the band has to be a `LEFT JOIN` plus a `CASE`.
 *
 * Ordering, paging and counting all stay in the database. These tables run to
 * thousands of rows; pulling a page's worth of candidates into JavaScript to
 * sort them would silently reorder only the current page.
 */

/**
 * CTE body naming the signed-in member's own marks.
 *
 * SCOPING: `userId` is the VIEWER's, always. On `/icps` and `/channel-partners`
 * the rows themselves are org-visible, but a mark is one member's private
 * opinion — joining on anyone else's would leak it and would order the list by
 * a judgement the reader never made.
 *
 * Materialized once per query and hash-joined rather than probed per row: the
 * set is one member's marks, small enough to sit in work_mem, and the
 * `@@unique([userId, identityKey])` index makes fetching it an index scan on
 * the `userId` prefix.
 */
export function userMarksSql(userId: string): Prisma.Sql {
  return Prisma.sql`
    user_marks AS (
      SELECT "identityKey", "value"
      FROM "ConnectionMark"
      WHERE "userId" = ${userId}
    )
  `;
}

/**
 * `LEFT JOIN user_marks` on a person-key expression from the outer query.
 *
 * LEFT, not INNER: an unmarked person is the common case and must stay on the
 * list, landing in the middle band.
 *
 * `keyExpr` is a SQL fragment this module's callers write as a literal (e.g.
 * `c."identityKey"`) — never anything derived from a query string.
 */
export function joinUserMarksSql(keyExpr: string): Prisma.Sql {
  return Prisma.raw(`LEFT JOIN user_marks um ON um."identityKey" = ${keyExpr}`);
}

/**
 * The band, as a SQL expression over the joined `um` alias.
 *
 * 0/1/2 rather than the enum itself because the enum's own order is
 * declaration order (`UP`, `DOWN`) and carries no NULL slot for "unmarked" —
 * the three-way ranking has to be spelled out.
 */
export const USEFULNESS_RANK_EXPR = `CASE um."value" WHEN 'UP' THEN 0 WHEN 'DOWN' THEN 2 ELSE 1 END`;

/** Selected as this column by every query below, so the ORDER BY can name it. */
export const USEFULNESS_RANK_COLUMN = "usefulnessRank";

/** `<rank expression> AS "usefulnessRank"`, for a SELECT list. */
export const USEFULNESS_RANK_SELECT = `${USEFULNESS_RANK_EXPR} AS "${USEFULNESS_RANK_COLUMN}"`;

/**
 * Prefixes an ORDER BY with the usefulness band.
 *
 * ALWAYS ascending: the band is a fixed product ordering (useful → unmarked →
 * not useful), not a dimension the reader flips. Reversing it with the `dir`
 * arrow would put the people you rejected at the top, which is the one thing
 * this rule exists to prevent.
 *
 * `rest` must already end on a unique tiebreaker (the row id) — see the note
 * on each caller's table. Without one, two rows tying on every key can swap
 * places between two page queries and paging duplicates and drops rows.
 */
export function usefulnessFirstByExpr(rest: string): Prisma.Sql {
  return Prisma.raw(`${USEFULNESS_RANK_EXPR} ASC, ${rest}`);
}

/**
 * Same, for a query that ordered a CTE which already SELECTed the rank with
 * `USEFULNESS_RANK_SELECT` — the action pages, whose ORDER BY runs in an outer
 * lateral where the `um` alias is out of scope.
 */
export function usefulnessFirstByColumn(rest: string): Prisma.Sql {
  return Prisma.raw(`"${USEFULNESS_RANK_COLUMN}" ASC, ${rest}`);
}

/**
 * Drops people the signed-in user has marked NOT USEFUL.
 *
 * For the "Do this next" lists only. Those are a worklist — a queue of people
 * to act on today — so someone explicitly dismissed does not belong in it at
 * all. That is a stronger rule than the ordering above, which merely sinks
 * them to the bottom: on a browsable list like `/connections` a thumbs-down
 * person should still be findable, because the list is a record of the network
 * rather than a set of instructions.
 *
 * Thumbs-UP and UNMARKED both stay. "Useful" here means "not ruled out", not
 * "explicitly endorsed" — filtering to only thumbs-up would empty the lists,
 * since almost nobody in a 5,000-person network has been judged either way.
 *
 * `NOT EXISTS` rather than a join and a rank test: this has to DROP the row,
 * and on the awaiting-reply list a filtered join would instead stop the thread
 * resolving to a connection, which would quietly recount a dismissed person as
 * an unlinked one in that page's footnote.
 *
 * `keyExpr` is SQL we wrote (a column reference), never anything from a query
 * string.
 */
export function excludeNotUsefulSql(keyExpr: string, userId: string): Prisma.Sql {
  return Prisma.sql`AND NOT EXISTS (
    SELECT 1 FROM "ConnectionMark" nm
    WHERE nm."userId" = ${userId}
      AND nm."identityKey" = ${Prisma.raw(keyExpr)}
      AND nm."value" = 'DOWN'
  )`;
}
