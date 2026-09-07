import "server-only";

import type { MatchType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deriveRelationshipStrength } from "@/lib/insights/relationship";
import { loadInteractionSignals } from "@/lib/insights/load-signals";
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

export type MatchSortKey = "score" | "name" | "company";

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
    rawSort === "name" || rawSort === "company" ? rawSort : "score";

  return {
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
    sort,
    // Score sorts high-to-low by default; that is the whole point of the view.
    direction: read("dir") === "asc" ? ("asc" as const) : ("desc" as const),
    query: (read("q") ?? "").trim(),
    /** Selected ICP or channel partner id, or "" for all. */
    definitionId: (read("def") ?? "").trim(),
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

function buildOrderBy(
  sort: MatchSortKey,
  direction: "asc" | "desc",
): Prisma.ProspectMatchOrderByWithRelationInput[] {
  switch (sort) {
    case "name":
      return [{ connection: { firstName: direction } }, { score: "desc" }];
    case "company":
      return [{ connection: { company: direction } }, { score: "desc" }];
    case "score":
    default:
      return [{ score: direction }, { connection: { lastName: "asc" } }];
  }
}

export type MatchRow = ProspectRow & {
  matchScore: number;
  rationale: string | null;
  definitionName: string;
};

/** One page of matches, with counts, for `ProspectTable`. */
export async function fetchMatchPage({
  matchType,
  importBatchId,
  organizationId,
  page,
  sort,
  direction,
  query,
  definitionId,
  pageSize = MATCH_PAGE_SIZE,
}: {
  matchType: MatchType;
  importBatchId: string;
  organizationId: string;
  page: number;
  sort: MatchSortKey;
  direction: "asc" | "desc";
  query: string;
  definitionId: string;
  pageSize?: number;
}): Promise<{ rows: MatchRow[]; total: number; page: number }> {
  const where = buildWhere({ matchType, importBatchId, organizationId, definitionId, query });

  const total = await prisma.prospectMatch.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);

  if (total === 0) return { rows: [], total, page: safePage };

  const matches = await prisma.prospectMatch.findMany({
    where,
    orderBy: buildOrderBy(sort, direction),
    skip: (safePage - 1) * pageSize,
    take: pageSize,
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
        },
      },
    },
  });

  // Signals are loaded once for exactly the people on this page.
  const refs = matches.map((match) => toPersonRef(match.connection));
  const signals = await loadInteractionSignals(importBatchId, refs);

  const rows: MatchRow[] = matches.map((match, index) => {
    const identityKey = refs[index].identityKey;
    const strength = deriveRelationshipStrength({
      signals,
      identityKey,
      connectedOn: match.connection.connectedOn,
    });
    return {
      id: match.id,
      firstName: match.connection.firstName,
      lastName: match.connection.lastName,
      company: match.connection.company,
      position: match.connection.position,
      linkedinUrl: match.connection.linkedinUrl,
      status: deriveLeadStatus({ isConnected: true, signals, identityKey }),
      relationshipScore: strength?.score ?? null,
      relationshipFactors: strength?.factors,
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
