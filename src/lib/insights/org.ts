import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Org-level reads shared by the org dashboard and the quick-suggestions job.
 *
 * Every function here takes an `organizationId` and filters on it. There is no
 * "all orgs" variant on purpose — a helper that can be called without a tenant
 * is a helper that eventually is.
 */

export type OrgMember = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "MEMBER";
  lastImportAt: Date | null;
  /** Their latest COMPLETE import batch, or null if they have never imported. */
  latestBatchId: string | null;
  latestBatchAt: Date | null;
  /** Connections in that latest batch. 0 when there is no batch. */
  connectionCount: number;
};

/**
 * Every member of the org with their current snapshot.
 *
 * "Current" means the same thing here as everywhere else in ProspectFlow: the
 * user's most recent COMPLETE `ImportBatch`. Batches are append-only, so this
 * is a lookup, not an aggregation.
 */
export async function listOrgMembers(organizationId: string): Promise<OrgMember[]> {
  const users = await prisma.user.findMany({
    where: { organizationId },
    orderBy: [{ name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      lastImportAt: true,
      importBatches: {
        where: { status: "COMPLETE" },
        orderBy: { completedAt: "desc" },
        take: 1,
        select: { id: true, completedAt: true, createdAt: true },
      },
    },
  });

  const batchIds = users
    .map((user) => user.importBatches[0]?.id)
    .filter((id): id is string => Boolean(id));

  const counts = new Map<string, number>();
  if (batchIds.length > 0) {
    const grouped = await prisma.connection.groupBy({
      by: ["importBatchId"],
      where: { importBatchId: { in: batchIds } },
      _count: { _all: true },
    });
    for (const row of grouped) counts.set(row.importBatchId, row._count._all);
  }

  return users.map((user) => {
    const batch = user.importBatches[0] ?? null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      lastImportAt: user.lastImportAt,
      latestBatchId: batch?.id ?? null,
      latestBatchAt: batch ? (batch.completedAt ?? batch.createdAt) : null,
      connectionCount: batch ? (counts.get(batch.id) ?? 0) : 0,
    };
  });
}

export type ConnectionsPoint = {
  /** ISO date (yyyy-mm-dd) of the import this point was measured at. */
  date: string;
  count: number;
};

export type ConnectionsSeries = {
  userId: string;
  userName: string;
  points: ConnectionsPoint[];
};

/**
 * Connections per user over time.
 *
 * Every completed `ImportBatch` is a DATED SNAPSHOT of one person's network, and
 * batches are never overwritten — so the series is a genuine measurement, not an
 * estimate: one point per import, counting the connections in that batch. A user
 * with a single import gets a single point (drawn as a dot, not a line), and a
 * user with none gets no series at all rather than a flat zero line.
 *
 * Bounded by `maxBatchesPerUser` so a very active importer cannot make this
 * query, or the rendered chart, unbounded.
 */
export async function fetchConnectionsOverTime(
  organizationId: string,
  { maxBatchesPerUser = 24 }: { maxBatchesPerUser?: number } = {},
): Promise<ConnectionsSeries[]> {
  const users = await prisma.user.findMany({
    where: { organizationId },
    orderBy: [{ name: "asc" }],
    select: {
      id: true,
      name: true,
      importBatches: {
        where: { status: "COMPLETE" },
        orderBy: { completedAt: "desc" },
        take: maxBatchesPerUser,
        select: { id: true, completedAt: true, createdAt: true },
      },
    },
  });

  const batchIds = users.flatMap((user) => user.importBatches.map((batch) => batch.id));
  if (batchIds.length === 0) return [];

  const grouped = await prisma.connection.groupBy({
    by: ["importBatchId"],
    where: { importBatchId: { in: batchIds } },
    _count: { _all: true },
  });
  const counts = new Map(grouped.map((row) => [row.importBatchId, row._count._all]));

  return users
    .map((user) => ({
      userId: user.id,
      userName: user.name,
      points: user.importBatches
        .map((batch) => ({
          date: (batch.completedAt ?? batch.createdAt).toISOString().slice(0, 10),
          count: counts.get(batch.id) ?? 0,
        }))
        // The query fetched newest-first (to apply `take`); the chart reads
        // oldest-first.
        .reverse(),
    }))
    .filter((series) => series.points.length > 0);
}
