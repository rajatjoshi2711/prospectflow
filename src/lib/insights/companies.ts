import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { companyKeySql, normalizeCompanyName } from "@/lib/companies/normalize";

/**
 * ACCOUNT MAPPING — the /companies section.
 *
 * WHY THIS IS ALL SQL
 * -------------------
 * A real export is ~5,580 connections and ~18,650 messages. Normalising and
 * grouping company names in JavaScript would mean shipping every connection
 * row out of Postgres on every page load, and the "has been messaged" signal
 * would mean shipping the messages too. Every aggregate below is therefore
 * computed in Postgres; only the 25 rows actually rendered come back. See
 * `src/lib/insights/prospecting-actions.ts`, which established this pattern.
 *
 * THE "MESSAGED" ANTI-JOIN is the one from `prospecting-actions.ts`, reused
 * verbatim in shape: the set of counterparty keys appearing anywhere in the
 * batch's messages is materialised ONCE (a UNION of distinct `identityKey`s
 * and distinct `nameKey`s — a few thousand keys), then hash-anti-joined
 * against connections. Written as a correlated NOT EXISTS over
 * `MessageRecord` the planner would re-probe the message table per connection.
 * The `nameKey` half of that join is inexact — two people with the same
 * display name share a key — and the UI says so.
 *
 * TENANCY: every query is filtered to one `importBatchId`, which the caller
 * resolved from the signed-in user's own latest COMPLETE batch. The ICP signal
 * is additionally filtered to the caller's `organizationId`, so a definition
 * belonging to another org can never contribute to a count.
 *
 * GROUPING IS APPROXIMATE. See `src/lib/companies/normalize.ts` for what the
 * normalisation can and cannot do. `spellings` is carried on every row so the
 * UI can show the reader how many raw variants were folded together instead of
 * asserting a certainty that does not exist.
 */

export const COMPANY_PAGE_SIZE = 25;

export type CompanySortKey = "name" | "connections" | "messaged" | "strength" | "icp";

export type CompanyRow = {
  /** Normalised grouping key; what the URL carries. */
  key: string;
  /** The most common raw spelling in this batch — what a human would call it. */
  displayName: string;
  /** How many distinct raw spellings folded into this group. 1 = nothing folded. */
  spellings: number;
  connections: number;
  /** Connections here with at least one message in the batch. */
  messaged: number;
  /**
   * Highest materialized `Connection.relationshipScore` at this company, or
   * null when NOBODY here has been scored. Null is "not yet scored", never 0 —
   * see the column's doc comment in schema.prisma.
   */
  bestRelationshipScore: number | null;
  /** How many people here carry a score at all, so the UI can qualify the best. */
  scoredConnections: number;
  /** How many people here match at least one of the org's ICPs. */
  icpMatches: number;
};

export function parseCompanySearchParams(
  params: Record<string, string | string[] | undefined>,
) {
  const read = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const rawPage = Number.parseInt(read("page") ?? "1", 10);
  const rawSort = read("sort");
  const sort: CompanySortKey =
    rawSort === "name" ||
    rawSort === "messaged" ||
    rawSort === "strength" ||
    rawSort === "icp"
      ? rawSort
      : "connections";

  return {
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
    sort,
    // Headcount-style columns read best biggest-first; the name column is the
    // only one people expect A-Z, and it flips itself below.
    direction: read("dir") === "asc" ? ("asc" as const) : ("desc" as const),
    query: (read("q") ?? "").trim(),
  };
}

const COMPANY_ORDER_BY: Record<CompanySortKey, (direction: string) => string> = {
  // Ties broken by the display name so paging is stable: without a unique
  // tiebreak, two companies with the same count can swap between pages and a
  // reader can see one twice and another never.
  name: (d) => `g."displayName" ${d}, g.key ASC`,
  connections: (d) => `g.connections ${d}, g."displayName" ASC`,
  messaged: (d) => `g.messaged ${d}, g.connections DESC, g."displayName" ASC`,
  // NULLS LAST in both directions: no score means unknown, not weak, so an
  // unscored company never leads the ascending list.
  strength: (d) => `g."bestRelationshipScore" ${d} NULLS LAST, g."displayName" ASC`,
  icp: (d) => `g."icpMatches" ${d}, g.connections DESC, g."displayName" ASC`,
};

/**
 * The per-connection CTE every company query starts from: one row per
 * connection in the batch that HAS a company, carrying its normalised key, its
 * raw spelling, its score, whether it has ever been messaged, and whether it
 * matches one of the org's ICPs.
 *
 * COST: one index scan of `Connection` on `importBatchId`
 * (`@@index([importBatchId])`, ~5.6k rows), one index scan of `MessageRecord`
 * on `importBatchId` (~18.6k rows) feeding a hash aggregate, one index scan of
 * `ProspectMatch` on `(matchType, score)` joined to `ICP` on
 * `@@index([organizationId])`, then hash anti-/left joins. Nothing here is
 * correlated per row and nothing scales with the number of rows rendered.
 */
function companyConnectionsCte(importBatchId: string, organizationId: string) {
  return Prisma.sql`
    messaged AS (
      SELECT DISTINCT "identityKey" AS k
      FROM "MessageRecord"
      WHERE "importBatchId" = ${importBatchId}
      UNION
      SELECT DISTINCT "nameKey" AS k
      FROM "MessageRecord"
      WHERE "importBatchId" = ${importBatchId} AND "nameKey" IS NOT NULL
    ),
    icp_matched AS (
      SELECT DISTINCT pm."connectionId" AS cid
      FROM "ProspectMatch" pm
      JOIN "ICP" i ON i."id" = pm."icpId"
      WHERE pm."matchType" = 'ICP' AND i."organizationId" = ${organizationId}
    ),
    conn AS (
      SELECT
        ${Prisma.raw(companyKeySql('c."company"'))} AS key,
        btrim(c."company") AS raw,
        c."relationshipScore" AS score,
        (im.cid IS NOT NULL) AS icp_match,
        (
          NOT EXISTS (SELECT 1 FROM messaged m WHERE m.k = c."identityKey")
          AND (c."nameKey" IS NULL OR NOT EXISTS (SELECT 1 FROM messaged m WHERE m.k = c."nameKey"))
        ) AS never_messaged
      FROM "Connection" c
      LEFT JOIN icp_matched im ON im.cid = c."id"
      WHERE c."importBatchId" = ${importBatchId}
        AND c."company" IS NOT NULL
        AND btrim(c."company") <> ''
    ),
    by_raw AS (
      SELECT key, raw, COUNT(*)::int AS n FROM conn WHERE key IS NOT NULL GROUP BY key, raw
    ),
    display AS (
      -- The most common raw spelling wins, ties broken alphabetically so the
      -- label a company shows is stable across page loads rather than
      -- whichever variant the planner happened to reach first.
      SELECT DISTINCT ON (key) key, raw AS "displayName"
      FROM by_raw
      ORDER BY key, n DESC, raw ASC
    ),
    agg AS (
      SELECT
        key,
        COUNT(*)::int                                        AS connections,
        (COUNT(*) FILTER (WHERE NOT never_messaged))::int    AS messaged,
        MAX(score)::int                                      AS "bestRelationshipScore",
        COUNT(score)::int                                    AS "scoredConnections",
        (COUNT(*) FILTER (WHERE icp_match))::int             AS "icpMatches",
        COUNT(DISTINCT raw)::int                             AS spellings
      FROM conn
      WHERE key IS NOT NULL
      GROUP BY key
    ),
    grouped AS (
      SELECT a.*, d."displayName" FROM agg a JOIN display d ON d.key = a.key
    )
  `;
}

/**
 * One page of companies, plus the total and the count of connections that
 * could not be placed at any company.
 *
 * SEARCH matches either the raw display spelling (what the reader sees) or the
 * normalised key against the normalised search term, so typing "Acme, Inc."
 * finds the group even though the group is called "acme".
 */
export async function fetchCompanyPage({
  importBatchId,
  organizationId,
  page,
  sort,
  direction,
  query,
  pageSize = COMPANY_PAGE_SIZE,
}: {
  importBatchId: string;
  organizationId: string;
  page: number;
  sort: CompanySortKey;
  direction: "asc" | "desc";
  query: string;
  pageSize?: number;
}): Promise<{
  rows: CompanyRow[];
  total: number;
  page: number;
  /** Connections in this batch with no company at all. Reported, never grouped. */
  withoutCompany: number;
}> {
  const normalizedQuery = normalizeCompanyName(query);
  const filter = query
    ? Prisma.sql`WHERE (g."displayName" ILIKE ${`%${query}%`} OR g.key LIKE ${`%${normalizedQuery}%`})`
    : Prisma.empty;

  // Two passes rather than one: the count drives the page clamp, and clamping
  // an out-of-range `?page=` before fetching is what stops a deep link landing
  // on a blank page.
  const [countRows, withoutCompanyRows] = await Promise.all([
    prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
      WITH ${companyConnectionsCte(importBatchId, organizationId)}
      SELECT COUNT(*)::int AS total FROM grouped g ${filter}
    `),
    prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS total
      FROM "Connection"
      WHERE "importBatchId" = ${importBatchId}
        AND ("company" IS NULL OR btrim("company") = '')
    `),
  ]);

  const total = countRows[0]?.total ?? 0;
  const withoutCompany = withoutCompanyRows[0]?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);

  if (total === 0) {
    return { rows: [], total, page: safePage, withoutCompany };
  }

  // `Prisma.raw` on the ORDER BY only — the clause comes from the whitelist
  // above keyed by an already-validated sort key, never from the query string.
  const orderBy = Prisma.raw(COMPANY_ORDER_BY[sort](direction === "asc" ? "ASC" : "DESC"));

  const rows = await prisma.$queryRaw<CompanyRow[]>(Prisma.sql`
    WITH ${companyConnectionsCte(importBatchId, organizationId)}
    SELECT g.key, g."displayName", g.spellings, g.connections, g.messaged,
           g."bestRelationshipScore", g."scoredConnections", g."icpMatches"
    FROM grouped g
    ${filter}
    ORDER BY ${orderBy}
    LIMIT ${pageSize} OFFSET ${(safePage - 1) * pageSize}
  `);

  return { rows, total, page: safePage, withoutCompany };
}

export type CompanyDetail = CompanyRow & {
  /**
   * Every raw spelling folded into this group, most common first. The company
   * page lists them so the reader can check the grouping with their own eyes.
   * Also what the people query filters on — see below.
   */
  spellingList: string[];
};

/**
 * One company by its normalised key, with the raw spellings behind it.
 *
 * The spelling list is load-bearing, not cosmetic: `Connection.company` is a
 * plain column, so the people at this company are fetched with a Prisma
 * `company: { in: [...spellings] }` filter rather than by re-running the
 * normalisation. That keeps the people query on the shared `fetchProspectPage`
 * path — same sorting, paging, marks and strength resolution as /connections —
 * instead of forking a second implementation of it. The list is bounded by how
 * many ways people spell one employer (a handful in practice), so the IN list
 * stays small.
 */
export async function fetchCompanyByKey({
  importBatchId,
  organizationId,
  companyKey,
}: {
  importBatchId: string;
  organizationId: string;
  companyKey: string;
}): Promise<CompanyDetail | null> {
  const rows = await prisma.$queryRaw<(CompanyRow & { spellingList: string[] })[]>(Prisma.sql`
    WITH ${companyConnectionsCte(importBatchId, organizationId)}
    SELECT g.key, g."displayName", g.spellings, g.connections, g.messaged,
           g."bestRelationshipScore", g."scoredConnections", g."icpMatches",
           (
             SELECT array_agg(b.raw ORDER BY b.n DESC, b.raw ASC)
             FROM by_raw b WHERE b.key = g.key
           ) AS "spellingList"
    FROM grouped g
    WHERE g.key = ${companyKey}
    LIMIT 1
  `);

  const row = rows[0];
  if (!row) return null;
  return { ...row, spellingList: row.spellingList ?? [] };
}
