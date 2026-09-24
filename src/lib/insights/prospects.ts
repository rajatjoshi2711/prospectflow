import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  deriveRelationshipStrength,
  resolveRelationshipStrength,
} from "@/lib/insights/relationship";
import { loadInteractionSignals } from "@/lib/insights/load-signals";
import { loadStoredRelationshipScores } from "@/lib/insights/load-stored-scores";
import { loadConnectionMarks } from "@/lib/insights/marks";
import {
  joinUserMarksSql,
  usefulnessFirstByExpr,
  userMarksSql,
} from "@/lib/insights/mark-order";
import { toPersonRef } from "@/lib/insights/signals";
import { deriveLeadStatus } from "@/lib/insights/status";
import type { ProspectRow, ProspectSortKey } from "@/components/prospect-table";

export const PROSPECT_PAGE_SIZE = 25;

/**
 * The "current" snapshot for a user is their most recent COMPLETE import
 * batch — batches are append-only (Phase 2), so every dashboard reads from
 * this one batch rather than from all of them.
 */
export async function getLatestCompleteBatch(userId: string) {
  return prisma.importBatch.findFirst({
    where: { userId, status: "COMPLETE" },
    orderBy: { completedAt: "desc" },
    select: { id: true, completedAt: true, createdAt: true },
  });
}

/**
 * How many people appear in the newest import that were not in the one before.
 *
 * "New" means new TO THE EXPORT, matched on `identityKey` — the same stable
 * person key job-change detection diffs on. It is not `connectedOn`: LinkedIn
 * backfills that with the real connection date, so someone who accepted months
 * ago but only now shows up in an export is still new information to the user.
 *
 * Returns null when there is nothing to compare against — a first (or only)
 * import. That is a different fact from "no new connections", and the card
 * says so rather than printing a zero that would read as "nobody accepted".
 *
 * COST: two index scans on `@@index([userId, status, completedAt])` to find the
 * batches, then one anti-join between the two batches' connections, both sides
 * riding `@@index([importBatchId])`. Counting happens in Postgres; no rows come
 * back.
 */
export async function countNewConnectionsSinceLastImport(userId: string): Promise<{
  count: number;
  comparedTo: Date;
} | null> {
  const batches = await prisma.importBatch.findMany({
    where: { userId, status: "COMPLETE" },
    orderBy: { completedAt: "desc" },
    take: 2,
    select: { id: true, completedAt: true, createdAt: true },
  });
  if (batches.length < 2) return null;

  const [latest, previous] = batches;
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM "Connection" c
    WHERE c."importBatchId" = ${latest.id}
      AND NOT EXISTS (
        SELECT 1 FROM "Connection" p
        WHERE p."importBatchId" = ${previous.id}
          AND p."identityKey" = c."identityKey"
      )
  `;

  return {
    count: rows[0]?.n ?? 0,
    comparedTo: previous.completedAt ?? previous.createdAt,
  };
}

/** The sort keys `/connections` itself offers. */
const CONNECTIONS_SORT_KEYS: ProspectSortKey[] = ["name", "company", "connectedOn", "strength"];

export function parseProspectSearchParams(
  params: Record<string, string | string[] | undefined>,
  /**
   * Lets a view widen or narrow what `?sort=` may say and what it defaults to.
   *
   * The action pages (Phase 8) need this: their whole point is an ordering the
   * connections list has no column for ("longest waiting first"), and a sort
   * key a view cannot actually execute must not be accepted from a pasted URL
   * — it would silently render in some other order than the header claims.
   */
  options?: {
    sortKeys?: ProspectSortKey[];
    defaultSort?: ProspectSortKey;
    defaultDirection?: "asc" | "desc";
  },
) {
  const read = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const allowed = options?.sortKeys ?? CONNECTIONS_SORT_KEYS;
  const fallbackSort = options?.defaultSort ?? allowed[0] ?? "name";

  const rawPage = Number.parseInt(read("page") ?? "1", 10);
  const rawSort = read("sort");
  const rawDirection = read("dir");

  const sort: ProspectSortKey = allowed.includes(rawSort as ProspectSortKey)
    ? (rawSort as ProspectSortKey)
    : fallbackSort;

  return {
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
    sort,
    direction:
      rawDirection === "desc"
        ? ("desc" as const)
        : rawDirection === "asc"
          ? ("asc" as const)
          : (options?.defaultDirection ?? ("asc" as const)),
    query: (read("q") ?? "").trim(),
  };
}

/**
 * The search box's predicate, as SQL.
 *
 * Exists so a view that has to page in raw SQL (the action pages' populations
 * cannot be expressed as a Prisma `where`) filters on exactly the same terms as
 * `buildWhere` below, rather than growing its own near-miss version. Every
 * whitespace-separated term must match somewhere, capped at five.
 *
 * Returns `Prisma.empty` for an empty query, so it can be interpolated
 * unconditionally into a WHERE clause.
 */
export function connectionSearchSql(query: string, alias: string): Prisma.Sql {
  const column = (name: string) => Prisma.raw(`${alias}."${name}"`);
  const terms = query.split(/\s+/).filter(Boolean).slice(0, 5);
  if (terms.length === 0) return Prisma.empty;
  return Prisma.sql`AND ${Prisma.join(
    terms.map(
      (term) =>
        Prisma.sql`(${column("firstName")} ILIKE ${`%${term}%`} OR ${column("lastName")} ILIKE ${`%${term}%`} OR ${column("company")} ILIKE ${`%${term}%`})`,
    ),
    " AND ",
  )}`;
}

function buildWhere(
  importBatchId: string,
  query: string,
  /**
   * Exact raw `company` spellings to restrict to. Used by /companies/[key]:
   * a company group is a set of raw spellings that normalise to one key, and
   * listing them here keeps that page on this shared path rather than forking
   * a second paging implementation. Undefined means "no company restriction".
   */
  companyIn?: string[],
): Prisma.ConnectionWhereInput {
  const companyScope: Prisma.ConnectionWhereInput = companyIn ? { company: { in: companyIn } } : {};

  if (!query) return { importBatchId, ...companyScope };

  // Each whitespace-separated term must match somewhere, so "jane acme"
  // finds Jane at Acme rather than everyone called Jane or working at Acme.
  const terms = query.split(/\s+/).filter(Boolean).slice(0, 5);
  return {
    importBatchId,
    ...companyScope,
    AND: terms.map((term) => ({
      OR: [
        { firstName: { contains: term, mode: "insensitive" as const } },
        { lastName: { contains: term, mode: "insensitive" as const } },
        { company: { contains: term, mode: "insensitive" as const } },
      ],
    })),
  };
}

function dir(direction: "asc" | "desc") {
  return direction === "desc" ? "DESC" : "ASC";
}

/**
 * ORDER BY clauses for the connections list, keyed by an already-validated
 * sort key. These are the SECONDARY keys: `usefulnessFirstByExpr` puts the
 * Usefulness band in front of whichever one the reader picked.
 *
 * Every clause ends on `c."id"`, a unique value, so two rows tying on the
 * dimension keep a fixed relative order between the page-1 and page-2 queries.
 * Without that, paging duplicates some rows and drops others.
 *
 * NULLS LAST in BOTH directions throughout: a missing company or an unscored
 * relationship is unknown, not "empty" or "weak", so it never leads the
 * ascending list.
 */
const PROSPECT_ORDER_BY: Partial<Record<ProspectSortKey, (d: string) => string>> = {
  name: (d) => `c."firstName" ${d} NULLS LAST, c."lastName" ${d} NULLS LAST`,
  company: (d) => `c."company" ${d} NULLS LAST, c."lastName" ASC NULLS LAST`,
  connectedOn: (d) => `c."connectedOn" ${d} NULLS LAST, c."lastName" ASC NULLS LAST`,
  strength: (d) =>
    `c."relationshipScore" ${d} NULLS LAST, c."lastName" ASC NULLS LAST, c."firstName" ASC NULLS LAST`,
};

function prospectOrderBySql(sort: ProspectSortKey, direction: "asc" | "desc"): Prisma.Sql {
  // Falls back to name rather than throwing: `?sort=` is already validated
  // against the view's allow-list, so this is only reachable from a
  // hand-edited URL and a 500 there would be worse than a sane order.
  const clause = (PROSPECT_ORDER_BY[sort] ?? PROSPECT_ORDER_BY.name)!;
  // `Prisma.raw` over a literal from the table above, selected by an
  // already-validated key — never over anything from the query string.
  return usefulnessFirstByExpr(`${clause(dir(direction))}, c."id" ASC`);
}

/**
 * The ids of one page of connections, ordered Usefulness-first.
 *
 * WHY RAW: the Usefulness band is a `LEFT JOIN` on `ConnectionMark.identityKey`
 * with no Prisma relation behind it (see `mark-order.ts`), so `orderBy` cannot
 * express it. Only the ≤25 ids of the page come back; the SELECT, the mark and
 * signal loads and the enrichment all stay on the one shared path below, the
 * same shape the action pages already use via `population`.
 *
 * COST: one index scan of `Connection` on `@@index([importBatchId])` (~5.6k
 * rows for the current import), hash-joined to the member's own marks (an index
 * scan of `ConnectionMark` on the `userId` prefix of
 * `@@unique([userId, identityKey])`, which also covers `value` — so the join is
 * index-only and needs no new index), then one sort and a LIMIT. The mark set
 * is one member's, so it stays small however large the network gets.
 */
async function fetchProspectIds({
  userId,
  importBatchId,
  companyIn,
  query,
  sort,
  direction,
  limit,
  offset,
}: {
  userId: string;
  importBatchId: string;
  companyIn?: string[];
  query: string;
  sort: ProspectSortKey;
  direction: "asc" | "desc";
  limit: number;
  offset: number;
}): Promise<string[]> {
  // An empty company list means "no spellings in this group" — `IN ()` is not
  // valid SQL, and the honest answer is an empty page, not every connection.
  if (companyIn && companyIn.length === 0) return [];

  const companyFilter = companyIn
    ? Prisma.sql`AND c."company" IN (${Prisma.join(companyIn)})`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH ${userMarksSql(userId)}
    SELECT c."id" AS id
    FROM "Connection" c
    ${joinUserMarksSql(`c."identityKey"`)}
    WHERE c."importBatchId" = ${importBatchId}
      ${companyFilter}
      ${connectionSearchSql(query, "c")}
    ORDER BY ${prospectOrderBySql(sort, direction)}
    LIMIT ${limit} OFFSET ${offset}
  `);

  return rows.map((row) => row.id);
}

/**
 * Fetches one page of prospects for `ProspectTable`, plus the total count.
 *
 * Both the count and the page come from the database — nothing is loaded into
 * memory to be counted or sliced in JS. Status and relationship strength are
 * derived only for the rows on this page.
 */
export async function fetchProspectPage({
  userId,
  importBatchId,
  page,
  sort,
  direction,
  query,
  companyIn,
  population,
  pageSize = PROSPECT_PAGE_SIZE,
}: {
  /**
   * Owner of `importBatchId`. Required because relationship scores are stored
   * per (user, connection): looking them up without the user filter would read
   * another member's reading of the same person.
   */
  userId: string;
  importBatchId: string;
  page: number;
  sort: ProspectSortKey;
  direction: "asc" | "desc";
  query: string;
  /** Restrict to these exact raw `Connection.company` values. See `buildWhere`. */
  companyIn?: string[];
  /**
   * A page that was already selected, ordered and counted in SQL.
   *
   * The "do this next" action pages need this. Their populations ("the latest
   * message in this thread was theirs", "no message either way") and their
   * orderings ("longest waiting first") are set-based things Prisma's query
   * builder cannot express, so `prospecting-actions.ts` resolves them in one
   * raw query and hands back just this page's connection ids. Everything after
   * that — status, Usefulness marks, relationship strength, the prospect-page
   * link — stays on this one shared path, so an action page and `/connections`
   * cannot render the same person differently.
   *
   * This is the same shape `fetchMatchPage` uses for its never-messaged view.
   */
  population?: { ids: string[]; total: number; page: number };
  pageSize?: number;
}): Promise<{ rows: ProspectRow[]; total: number; page: number }> {
  const where = buildWhere(importBatchId, query, companyIn);

  const total = population ? population.total : await prisma.connection.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = population ? population.page : Math.min(Math.max(1, page), totalPages);

  if (total === 0) {
    return { rows: [], total, page: safePage };
  }

  // Either the caller resolved the page in SQL (the action pages) or this does
  // it here — but it is always a list of ids in order, because the Usefulness
  // band that leads every ordering is a join Prisma cannot express.
  const orderedIds = population
    ? population.ids
    : await fetchProspectIds({
        userId,
        importBatchId,
        companyIn,
        query,
        sort,
        direction,
        limit: pageSize,
        offset: (safePage - 1) * pageSize,
      });

  if (orderedIds.length === 0) {
    return { rows: [], total, page: safePage };
  }

  const unordered = await prisma.connection.findMany({
    // The batch scope, company scope and search terms are re-applied alongside
    // the id list, so tenancy is enforced here and not only in the raw query.
    where: { AND: [where, { id: { in: orderedIds } }] },
    select: {
      id: true,
      identityKey: true,
      nameKey: true,
      firstName: true,
      lastName: true,
      company: true,
      position: true,
      linkedinUrl: true,
      connectedOn: true,
      relationshipScore: true,
      relationshipBasis: true,
    },
  });

  // `IN (...)` carries no order, so the SQL ordering is reapplied over the ≤25
  // rows of this page — a reshuffle of what the ORDER BY already decided, not a
  // re-sort of the data set.
  const connections = orderedIds
    .map((id) => unordered.find((connection) => connection.id === id))
    .filter((connection): connection is (typeof unordered)[number] => connection !== undefined);

  const refs = connections.map(toPersonRef);
  const [signals, storedScores, marks] = await Promise.all([
    loadInteractionSignals(importBatchId, refs),
    loadStoredRelationshipScores(
      userId,
      connections.map((connection) => connection.id),
    ),
    // One query for the page's keys, not one per row.
    loadConnectionMarks(
      userId,
      connections.map((connection) => connection.identityKey),
    ),
  ]);

  const rows: ProspectRow[] = connections.map((connection, index) => {
    const identityKey = refs[index].identityKey;
    // The materialized column is what the ORDER BY above read, so it is also
    // what must be displayed; the derivation still supplies the hover factors
    // and covers rows no scoring run has reached.
    const strength = resolveRelationshipStrength({
      materialized: {
        score: connection.relationshipScore,
        basis: connection.relationshipBasis,
      },
      derived: deriveRelationshipStrength({
        signals,
        identityKey,
        connectedOn: connection.connectedOn,
        stored: storedScores.get(connection.id) ?? null,
      }),
    });
    return {
      id: connection.id,
      identityKey,
      // Marks are keyed on identityKey, so they follow the person across
      // imports even though `connection.id` does not.
      mark: marks.get(identityKey) ?? null,
      firstName: connection.firstName,
      lastName: connection.lastName,
      company: connection.company,
      position: connection.position,
      linkedinUrl: connection.linkedinUrl,
      status: deriveLeadStatus({ isConnected: true, signals, identityKey }),
      relationshipScore: strength?.score ?? null,
      relationshipFactors: strength?.factors,
      relationshipBasis: strength?.basis ?? null,
    };
  });

  return { rows, total, page: safePage };
}
