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

function buildOrderBy(
  sort: ProspectSortKey,
  direction: "asc" | "desc",
): Prisma.ConnectionOrderByWithRelationInput[] {
  switch (sort) {
    case "company":
      return [{ company: direction }, { lastName: "asc" }];
    case "connectedOn":
      return [{ connectedOn: direction }, { lastName: "asc" }];
    case "strength":
      // NULLs last in BOTH directions: an unscored connection is unknown, not
      // weak, so it never leads the ascending list. Before the first scoring
      // run every row is null and this degrades to the name tiebreak, which is
      // stable rather than arbitrary.
      return [
        { relationshipScore: { sort: direction, nulls: "last" } },
        { lastName: "asc" },
        { firstName: "asc" },
      ];
    case "name":
    default:
      return [{ firstName: direction }, { lastName: direction }];
  }
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
  // The search terms and batch scope are applied here too, not only inside the
  // raw population query, so tenancy is enforced on both paths.
  const where = population
    ? { AND: [buildWhere(importBatchId, query, companyIn), { id: { in: population.ids } }] }
    : buildWhere(importBatchId, query, companyIn);

  const total = population ? population.total : await prisma.connection.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = population ? population.page : Math.min(Math.max(1, page), totalPages);

  if (total === 0) {
    return { rows: [], total, page: safePage };
  }

  const unordered = await prisma.connection.findMany({
    where,
    ...(population
      ? {}
      : {
          orderBy: buildOrderBy(sort, direction),
          skip: (safePage - 1) * pageSize,
          take: pageSize,
        }),
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
  const connections = population
    ? population.ids
        .map((id) => unordered.find((connection) => connection.id === id))
        .filter((connection): connection is (typeof unordered)[number] => connection !== undefined)
    : unordered;

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
