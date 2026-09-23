import "server-only";

import { Prisma, type MatchType } from "@prisma/client";
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
import type { ProspectRow } from "@/components/prospect-table";

/**
 * Reads `ProspectMatch` rows for the match dashboards.
 *
 * Everything is scoped twice over: to the user's own latest COMPLETE import
 * batch (so a match against a stale snapshot never shows), and to definitions
 * owned by the caller's organization (so no cross-tenant leak is possible even
 * if a definition id is guessed).
 *
 * Status and relationship strength come from the Phase 3 helpers, unchanged —
 * this module only adds "which definition, and why".
 */

export const MATCH_PAGE_SIZE = 25;

export type MatchSortKey = "score" | "name" | "company" | "strength";

export function parseMatchSearchParams(
  params: Record<string, string | string[] | undefined>,
) {
  const read = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const rawPage = Number.parseInt(read("page") ?? "1", 10);
  const rawSort = read("sort");

  const sort: MatchSortKey =
    rawSort === "name" || rawSort === "company" || rawSort === "strength"
      ? rawSort
      : "score";

  return {
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
    sort,
    // Score sorts high-to-low by default; that is the whole point of the view.
    direction: read("dir") === "asc" ? ("asc" as const) : ("desc" as const),
    query: (read("q") ?? "").trim(),
    /** Selected ICP or channel partner id, or "" for all. */
    definitionId: (read("def") ?? "").trim(),
    /**
     * "Show only the people I have never messaged". A view opts INTO honouring
     * this (see `MatchDashboard`'s `neverMessaged` prop) — parsing it here for
     * everyone would silently change a URL's meaning on a dashboard that
     * renders no control for it.
     */
    unmessagedOnly: read("untapped") === "1",
  };
}

function buildWhere({
  matchType,
  importBatchId,
  organizationId,
  definitionId,
  query,
}: {
  matchType: MatchType;
  importBatchId: string;
  organizationId: string;
  definitionId: string;
  query: string;
}): Prisma.ProspectMatchWhereInput {
  const definitionScope: Prisma.ProspectMatchWhereInput =
    matchType === "ICP"
      ? {
          icp: {
            organizationId,
            ...(definitionId ? { id: definitionId } : {}),
          },
        }
      : {
          channelPartner: {
            organizationId,
            ...(definitionId ? { id: definitionId } : {}),
          },
        };

  const terms = query.split(/\s+/).filter(Boolean).slice(0, 5);

  return {
    matchType,
    ...definitionScope,
    connection: {
      importBatchId,
      ...(terms.length > 0
        ? {
            AND: terms.map((term) => ({
              OR: [
                { firstName: { contains: term, mode: "insensitive" as const } },
                { lastName: { contains: term, mode: "insensitive" as const } },
                { company: { contains: term, mode: "insensitive" as const } },
              ],
            })),
          }
        : {}),
    },
  };
}

/**
 * THE CANDIDATE SET for both halves of a match dashboard.
 *
 * NEVER MESSAGED — the untapped half of a match dashboard.
 *
 * DEFINITION: no `MessageRecord` in the batch whose counterparty `identityKey`
 * or `nameKey` matches the connection's. That is the established counterparty
 * join (`load-signals.ts`, `process-import.ts`), and the `nameKey` half of it
 * is inexact — two people with the same display name share a key, so someone
 * who shares a name with a person you HAVE messaged can be wrongly excluded
 * from this list. The UI says so rather than presenting the count as exact.
 *
 * WHY RAW SQL: the anti-join cannot be written as a Prisma `where` without
 * first pulling the set of messaged keys (thousands) into JavaScript. The
 * shape below is the one `prospecting-actions.ts` established — materialise
 * the key set once, then hash-anti-join — rather than a correlated NOT EXISTS
 * that would re-probe ~18.6k message rows per candidate.
 *
 * COST: one index scan of `MessageRecord` on `@@index([importBatchId])`
 * feeding a hash aggregate; one index scan of `ProspectMatch` on
 * `@@index([matchType, score])` joined to the definition table on
 * `@@index([organizationId])` and to `Connection` by primary key; one hash
 * anti-join. No new index is required.
 */
function matchCandidatesSql({
  matchType,
  importBatchId,
  organizationId,
  definitionId,
  query,
  neverMessagedOnly,
}: {
  matchType: MatchType;
  importBatchId: string;
  organizationId: string;
  definitionId: string;
  query: string;
  /**
   * Adds the anti-join. False for the ordinary view, which is otherwise the
   * same set — one CTE rather than two near-identical ones, so the two halves
   * of the dashboard cannot drift apart on scoping or search semantics.
   */
  neverMessagedOnly: boolean;
}): Prisma.Sql {
  // Table and foreign key are chosen from `matchType`, an enum the caller
  // already holds — never from the query string.
  const definitionTable = Prisma.raw(matchType === "ICP" ? `"ICP"` : `"ChannelPartner"`);
  const definitionFk = Prisma.raw(matchType === "ICP" ? `pm."icpId"` : `pm."channelPartnerId"`);

  // Same term semantics as `buildWhere`: every term must match somewhere.
  const terms = query.split(/\s+/).filter(Boolean).slice(0, 5);
  const search =
    terms.length === 0
      ? Prisma.empty
      : Prisma.sql`AND ${Prisma.join(
          terms.map(
            (term) =>
              Prisma.sql`(c."firstName" ILIKE ${`%${term}%`} OR c."lastName" ILIKE ${`%${term}%`} OR c."company" ILIKE ${`%${term}%`})`,
          ),
          " AND ",
        )}`;

  const definitionFilter = definitionId
    ? Prisma.sql`AND d."id" = ${definitionId}`
    : Prisma.empty;

  // The key set is materialized once and hash-anti-joined; see the note above.
  // Emitted only for the untapped view — the ordinary view would pay a full
  // pass over `MessageRecord` for a CTE it never references.
  const messagedCte = neverMessagedOnly
    ? Prisma.sql`
    messaged AS (
      SELECT DISTINCT "identityKey" AS k
      FROM "MessageRecord"
      WHERE "importBatchId" = ${importBatchId}
      UNION
      SELECT DISTINCT "nameKey" AS k
      FROM "MessageRecord"
      WHERE "importBatchId" = ${importBatchId} AND "nameKey" IS NOT NULL
    ),`
    : Prisma.empty;

  const antiJoin = neverMessagedOnly
    ? Prisma.sql`
        AND NOT EXISTS (SELECT 1 FROM messaged m WHERE m.k = c."identityKey")
        AND (c."nameKey" IS NULL OR NOT EXISTS (SELECT 1 FROM messaged m WHERE m.k = c."nameKey"))`
    : Prisma.empty;

  return Prisma.sql`
    ${messagedCte}
    cand AS (
      SELECT pm."id"              AS id,
             pm."score"           AS score,
             c."identityKey"      AS "identityKey",
             c."firstName"        AS "firstName",
             c."lastName"         AS "lastName",
             c."company"          AS "company",
             c."relationshipScore" AS "relationshipScore"
      FROM "ProspectMatch" pm
      JOIN ${definitionTable} d ON d."id" = ${definitionFk}
      JOIN "Connection" c ON c."id" = pm."connectionId"
      WHERE pm."matchType" = ${matchType}::"MatchType"
        AND d."organizationId" = ${organizationId}
        AND c."importBatchId" = ${importBatchId}
        ${definitionFilter}
        ${search}
        ${antiJoin}
    )
  `;
}

/**
 * How many matches the user has never messaged, under the CURRENT definition
 * filter and search. Counts match rows, not people, so it is directly
 * comparable with the table's own total (a person matching two ICPs is two
 * rows in both numbers).
 */
export async function countNeverMessagedMatches(args: {
  matchType: MatchType;
  importBatchId: string;
  organizationId: string;
  definitionId: string;
  query: string;
}): Promise<number> {
  const rows = await prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
    WITH ${matchCandidatesSql({ ...args, neverMessagedOnly: true })}
    SELECT COUNT(*)::int AS total FROM cand
  `);
  return rows[0]?.total ?? 0;
}

/**
 * The SECONDARY ordering — what the reader's chosen column does INSIDE each
 * Usefulness band. `usefulnessFirstByExpr` supplies the band in front.
 *
 * Every clause ends on `cand.id`, a unique value, so paging is stable when the
 * dimension ties. NULLS LAST in both directions: unscored is unknown, not weak,
 * and a missing company is unknown, not empty.
 */
const MATCH_ORDER_BY: Record<MatchSortKey, (direction: string) => string> = {
  score: (d) => `cand.score ${d}, cand."lastName" ASC NULLS LAST, cand.id ASC`,
  name: (d) => `cand."firstName" ${d} NULLS LAST, cand.score DESC, cand.id ASC`,
  company: (d) => `cand."company" ${d} NULLS LAST, cand.score DESC, cand.id ASC`,
  strength: (d) => `cand."relationshipScore" ${d} NULLS LAST, cand.score DESC, cand.id ASC`,
};

/**
 * One page of match IDs, in the requested order, plus the total.
 *
 * Returning IDS rather than rows is deliberate: the ordering, the Usefulness
 * band and (for the untapped view) the anti-join have to happen in SQL, but the
 * SELECT, the tenancy-scoped relation loads and the enrichment below stay on
 * the single Prisma path. Only the 25 ids of the page cross into JavaScript.
 *
 * `userId` is the VIEWER's. A match row is org-visible; the Usefulness mark
 * that orders it is the signed-in member's own, never another member's.
 *
 * COST, on top of the candidate scan documented above: a hash join to the
 * member's marks — an index scan of `ConnectionMark` on the `userId` prefix of
 * `@@unique([userId, identityKey])`, which also carries `value`, so it is
 * index-only and warrants no new index — then one sort and a LIMIT.
 */
async function fetchMatchIds({
  userId,
  sort,
  direction,
  page,
  pageSize,
  total,
  ...candidates
}: {
  userId: string;
  matchType: MatchType;
  importBatchId: string;
  organizationId: string;
  definitionId: string;
  query: string;
  neverMessagedOnly: boolean;
  sort: MatchSortKey;
  direction: "asc" | "desc";
  page: number;
  pageSize: number;
  /** Already counted by the caller, which knows the cheaper way for its path. */
  total: number;
}): Promise<{ ids: string[]; page: number }> {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  if (total === 0) return { ids: [], page: safePage };

  // `Prisma.raw` on the ORDER BY only, from the whitelist above keyed by an
  // already-validated sort key — never from the query string.
  const orderBy = usefulnessFirstByExpr(
    MATCH_ORDER_BY[sort](direction === "asc" ? "ASC" : "DESC"),
  );

  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH ${userMarksSql(userId)},
    ${matchCandidatesSql(candidates)}
    SELECT cand.id FROM cand
    ${joinUserMarksSql(`cand."identityKey"`)}
    ORDER BY ${orderBy}
    LIMIT ${pageSize} OFFSET ${(safePage - 1) * pageSize}
  `);

  return { ids: rows.map((row) => row.id), page: safePage };
}

export type MatchRow = ProspectRow & {
  matchScore: number;
  rationale: string | null;
  definitionName: string;
};

/** One page of matches, with counts, for `ProspectTable`. */
export async function fetchMatchPage({
  matchType,
  userId,
  importBatchId,
  organizationId,
  page,
  sort,
  direction,
  query,
  definitionId,
  unmessagedOnly = false,
  pageSize = MATCH_PAGE_SIZE,
}: {
  matchType: MatchType;
  /** Owner of `importBatchId`; scopes the stored relationship-score lookup. */
  userId: string;
  importBatchId: string;
  organizationId: string;
  page: number;
  sort: MatchSortKey;
  direction: "asc" | "desc";
  query: string;
  definitionId: string;
  /** Restrict to matches with no message history. See `neverMessagedCandidatesSql`. */
  unmessagedOnly?: boolean;
  pageSize?: number;
}): Promise<{ rows: MatchRow[]; total: number; page: number }> {
  const where = buildWhere({ matchType, importBatchId, organizationId, definitionId, query });
  const candidates = {
    matchType,
    importBatchId,
    organizationId,
    definitionId,
    query,
    neverMessagedOnly: unmessagedOnly,
  };

  // The count stays on the cheapest path for each view: a plain Prisma count
  // for the ordinary one, the raw anti-joined count for the untapped one.
  const total = unmessagedOnly
    ? await countNeverMessagedMatches(candidates)
    : await prisma.prospectMatch.count({ where });

  // BOTH views order and page in SQL. The untapped one has to (the anti-join
  // cannot be a Prisma predicate), and now the ordinary one does too: the
  // Usefulness band that leads every ordering is a join on
  // `ConnectionMark.identityKey` with no Prisma relation behind it.
  const idPage = await fetchMatchIds({
    ...candidates,
    userId,
    sort,
    direction,
    page,
    pageSize,
    total,
  });
  const safePage = idPage.page;

  if (total === 0 || idPage.ids.length === 0) return { rows: [], total, page: safePage };

  const unordered = await prisma.prospectMatch.findMany({
    // `where` is still applied alongside the id list, so the tenancy and batch
    // scoping is enforced on this path too and not only inside the raw query.
    where: { AND: [where, { id: { in: idPage.ids } }] },
    select: {
      id: true,
      score: true,
      rationale: true,
      icp: { select: { name: true } },
      channelPartner: { select: { name: true } },
      connection: {
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
      },
    },
  });

  // `IN (...)` has no order, so the SQL ordering is reapplied here over the 25
  // rows of the page — not a re-sort of the data set, just a reshuffle of what
  // the ORDER BY already decided.
  const matches = idPage.ids
    .map((id) => unordered.find((match) => match.id === id))
    .filter((match): match is (typeof unordered)[number] => match !== undefined);

  // Signals and stored scores are loaded once for exactly the people on this
  // page. The stored score lookup is filtered by `userId` — a match row is
  // org-visible, but the relationship behind it belongs to one member.
  const refs = matches.map((match) => toPersonRef(match.connection));
  // Marks are keyed by (userId, identityKey), so they are the signed-in
  // member's own take even though the match row itself is org-visible.
  const [signals, storedScores, marks] = await Promise.all([
    loadInteractionSignals(importBatchId, refs),
    loadStoredRelationshipScores(
      userId,
      matches.map((match) => match.connection.id),
    ),
    loadConnectionMarks(
      userId,
      refs.map((ref) => ref.identityKey),
    ),
  ]);

  const rows: MatchRow[] = matches.map((match, index) => {
    const identityKey = refs[index].identityKey;
    // Materialized column first, so the rows agree with the strength sort.
    const strength = resolveRelationshipStrength({
      materialized: {
        score: match.connection.relationshipScore,
        basis: match.connection.relationshipBasis,
      },
      derived: deriveRelationshipStrength({
        signals,
        identityKey,
        connectedOn: match.connection.connectedOn,
        stored: storedScores.get(match.connection.id) ?? null,
      }),
    });
    return {
      id: match.id,
      identityKey,
      mark: marks.get(identityKey) ?? null,
      firstName: match.connection.firstName,
      lastName: match.connection.lastName,
      company: match.connection.company,
      position: match.connection.position,
      linkedinUrl: match.connection.linkedinUrl,
      status: deriveLeadStatus({ isConnected: true, signals, identityKey }),
      relationshipScore: strength?.score ?? null,
      relationshipFactors: strength?.factors,
      relationshipBasis: strength?.basis ?? null,
      matchScore: match.score,
      rationale: match.rationale,
      definitionName: match.icp?.name ?? match.channelPartner?.name ?? "Unknown",
    };
  });

  return { rows, total, page: safePage };
}

export type CompanyGroup = {
  company: string;
  /** Highest match score at this company. */
  topScore: number;
  people: {
    name: string;
    position: string | null;
    linkedinUrl: string | null;
    score: number;
    definitionName: string;
    rationale: string | null;
  }[];
};

/**
 * Top matches for the dashboard's five-box, GROUPED BY COMPANY.
 *
 * Grouping is the explicit product requirement: three people at one target
 * account is one opportunity, not three, so the box shows five companies and
 * names everyone matched inside each.
 *
 * Implemented by pulling a bounded window of the highest-scoring matches
 * (`scanLimit`) and grouping in memory. A SQL GROUP BY cannot carry the
 * per-person detail the card renders, and the window is small and index-backed
 * (`ProspectMatch(matchType, score)`).
 */
export async function fetchTopMatchesByCompany({
  matchType,
  importBatchId,
  organizationId,
  groups = 5,
  scanLimit = 100,
}: {
  matchType: MatchType;
  importBatchId: string;
  organizationId: string;
  groups?: number;
  scanLimit?: number;
}): Promise<CompanyGroup[]> {
  const matches = await prisma.prospectMatch.findMany({
    where: buildWhere({
      matchType,
      importBatchId,
      organizationId,
      definitionId: "",
      query: "",
    }),
    orderBy: [{ score: "desc" }],
    take: scanLimit,
    select: {
      score: true,
      rationale: true,
      icp: { select: { name: true } },
      channelPartner: { select: { name: true } },
      connection: {
        select: {
          firstName: true,
          lastName: true,
          company: true,
          position: true,
          linkedinUrl: true,
        },
      },
    },
  });

  const byCompany = new Map<string, CompanyGroup>();

  for (const match of matches) {
    const rawCompany = match.connection.company?.trim();
    // People with no employer in the export cannot be grouped with anyone, so
    // each becomes their own entry rather than being lumped into one bogus
    // "unknown company" pile.
    const name =
      [match.connection.firstName, match.connection.lastName].filter(Boolean).join(" ").trim() ||
      "Unnamed connection";
    const key = rawCompany ? rawCompany.toLowerCase() : `__person__${name}-${match.score}`;
    const label = rawCompany || "No company in export";

    const existing = byCompany.get(key);
    const person = {
      name,
      position: match.connection.position,
      linkedinUrl: match.connection.linkedinUrl,
      score: match.score,
      definitionName: match.icp?.name ?? match.channelPartner?.name ?? "Unknown",
      rationale: match.rationale,
    };

    if (existing) {
      existing.people.push(person);
      existing.topScore = Math.max(existing.topScore, match.score);
    } else {
      byCompany.set(key, { company: label, topScore: match.score, people: [person] });
    }
  }

  return [...byCompany.values()]
    .sort((a, b) => b.topScore - a.topScore || b.people.length - a.people.length)
    .slice(0, groups);
}

/** Definitions for the dashboard filter dropdowns. */
export async function listDefinitions(matchType: MatchType, organizationId: string) {
  if (matchType === "ICP") {
    return prisma.iCP.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
  }
  return prisma.channelPartner.findMany({
    where: { organizationId },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}
