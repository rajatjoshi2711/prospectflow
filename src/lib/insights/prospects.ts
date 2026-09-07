import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deriveRelationshipStrength } from "@/lib/insights/relationship";
import { loadInteractionSignals } from "@/lib/insights/load-signals";
import { loadStoredRelationshipScores } from "@/lib/insights/load-stored-scores";
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

export function parseProspectSearchParams(params: Record<string, string | string[] | undefined>) {
  const read = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const rawPage = Number.parseInt(read("page") ?? "1", 10);
  const rawSort = read("sort");
  const rawDirection = read("dir");

  const sort: ProspectSortKey =
    rawSort === "company" || rawSort === "connectedOn" || rawSort === "name" ? rawSort : "name";

  return {
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
    sort,
    direction: rawDirection === "desc" ? ("desc" as const) : ("asc" as const),
    query: (read("q") ?? "").trim(),
  };
}

function buildWhere(importBatchId: string, query: string): Prisma.ConnectionWhereInput {
  if (!query) return { importBatchId };

  // Each whitespace-separated term must match somewhere, so "jane acme"
  // finds Jane at Acme rather than everyone called Jane or working at Acme.
  const terms = query.split(/\s+/).filter(Boolean).slice(0, 5);
  return {
    importBatchId,
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
  pageSize?: number;
}): Promise<{ rows: ProspectRow[]; total: number; page: number }> {
  const where = buildWhere(importBatchId, query);

  const total = await prisma.connection.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);

  if (total === 0) {
    return { rows: [], total, page: safePage };
  }

  const connections = await prisma.connection.findMany({
    where,
    orderBy: buildOrderBy(sort, direction),
    skip: (safePage - 1) * pageSize,
    take: pageSize,
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
  });

  const refs = connections.map(toPersonRef);
  const [signals, storedScores] = await Promise.all([
    loadInteractionSignals(importBatchId, refs),
    loadStoredRelationshipScores(
      userId,
      connections.map((connection) => connection.id),
    ),
  ]);

  const rows: ProspectRow[] = connections.map((connection, index) => {
    const identityKey = refs[index].identityKey;
    const strength = deriveRelationshipStrength({
      signals,
      identityKey,
      connectedOn: connection.connectedOn,
      stored: storedScores.get(connection.id) ?? null,
    });
    return {
      id: connection.id,
      firstName: connection.firstName,
      lastName: connection.lastName,
      company: connection.company,
      position: connection.position,
      linkedinUrl: connection.linkedinUrl,
      status: deriveLeadStatus({ isConnected: true, signals, identityKey }),
      relationshipScore: strength?.score ?? null,
      relationshipFactors: strength?.factors,
    };
  });

  return { rows, total, page: safePage };
}
