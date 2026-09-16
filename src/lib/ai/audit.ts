import "server-only";

import type { AiCallStatus, AiUseCase, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getModelRates, type ModelRates } from "@/lib/ai/pricing";
import {
  USE_CASES,
  type AiAuditFilters,
  type AiCallRow,
  type AiCallSortKey,
} from "@/lib/ai/audit-shared";

// Re-exported so server callers have one import for the whole audit model; the
// definitions live in the client-safe module. See `audit-shared.ts`.
export {
  USE_CASES,
  USE_CASE_LABELS,
  formatUsd,
  type AiAuditFilters,
  type AiCallRow,
  type AiCallSortKey,
} from "@/lib/ai/audit-shared";

/**
 * Read model for the AI audit dashboards.
 *
 * ORG SCOPING
 * -----------
 * Every exported function takes `organizationId` as its FIRST argument and puts
 * it in the `where` of every query. There is no code path here that reads
 * `AiCallLog` without it. The id comes from the verified session at the page or
 * route above; it is never taken from a query string, and no filter a user can
 * set can widen it — filters are ANDed into a where clause that already has the
 * tenant in it.
 *
 * AGGREGATION HAPPENS IN POSTGRES
 * -------------------------------
 * `AiCallLog` is the fastest-growing table in the app (a row per model call,
 * and matching alone makes one per batch of ten candidates). Nothing here
 * loads rows to add them up in JS — every total is a `groupBy`/`aggregate`, so
 * a million-row org costs the same round trip as an empty one. The only
 * `findMany` is the transaction list, which is a single bounded page.
 *
 * DECIMAL AT THE EDGE
 * -------------------
 * Costs are `Prisma.Decimal` in the database and are converted to `number` only
 * here, on the way out to a client component (a Decimal cannot cross the
 * server/client boundary). The conversion is the LAST step, after Postgres has
 * done the summing, so no precision is lost in the arithmetic that matters.
 */

/** `null` means unknown, never zero. See `estimateCost`. */
function toNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

/**
 * UTC throughout, matching the rate limiter's windows (`src/lib/ai/rate-limit.ts`).
 * An org spanning time zones would otherwise see "today" disagree between the
 * quota message and this dashboard.
 */
export type WindowKey = "hour" | "today" | "week" | "month";

export const WINDOW_LABELS: Record<WindowKey, string> = {
  hour: "Last hour",
  today: "Today (UTC)",
  week: "This week (UTC)",
  month: "This month (UTC)",
};

export function windowStart(key: WindowKey, now: Date): Date {
  switch (key) {
    // Rolling 60 minutes rather than the clock hour: "last hour" is what an
    // admin means when something is on fire right now.
    case "hour":
      return new Date(now.getTime() - 3_600_000);
    case "today":
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    case "week": {
      const day = now.getUTCDay();
      // ISO weeks start Monday; getUTCDay() makes Sunday 0, so it is day 7 back.
      const daysSinceMonday = day === 0 ? 6 : day - 1;
      const start = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      start.setUTCDate(start.getUTCDate() - daysSinceMonday);
      return start;
    }
    case "month":
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
}

export type WindowTotals = {
  key: WindowKey;
  label: string;
  calls: number;
  failedCalls: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  /** Sum of the rows we COULD price. */
  costUsd: number;
  /** Rows in this window whose model is not on the rate card. */
  unpricedCalls: number;
};

async function totalsForWindow(
  organizationId: string,
  key: WindowKey,
  now: Date,
): Promise<WindowTotals> {
  const createdAt = { gte: windowStart(key, now) };

  const [totals, failedCalls] = await Promise.all([
    prisma.aiCallLog.aggregate({
      where: { organizationId, createdAt },
      _sum: { totalTokens: true, promptTokens: true, completionTokens: true, costUsd: true },
      // `_count` on a nullable field counts NON-NULL rows, so `costUsd` here is
      // "calls we managed to price" and the difference from `_all` is the
      // unpriced remainder — reported rather than hidden inside the total.
      _count: { _all: true, costUsd: true },
    }),
    prisma.aiCallLog.count({ where: { organizationId, createdAt, status: "ERROR" } }),
  ]);

  return {
    key,
    label: WINDOW_LABELS[key],
    calls: totals._count._all,
    failedCalls,
    totalTokens: totals._sum.totalTokens ?? 0,
    promptTokens: totals._sum.promptTokens ?? 0,
    completionTokens: totals._sum.completionTokens ?? 0,
    costUsd: toNumber(totals._sum.costUsd) ?? 0,
    unpricedCalls: totals._count._all - totals._count.costUsd,
  };
}

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

export type UserUsageRow = {
  userId: string | null;
  name: string;
  calls: number;
  totalTokens: number;
  costUsd: number;
  unpricedCalls: number;
};

export type UseCaseUsageRow = {
  useCase: AiUseCase;
  calls: number;
  totalTokens: number;
  costUsd: number;
  /** Mean cost of the PRICED calls in this use case. Null when none were priced. */
  averageCostUsd: number | null;
  unpricedCalls: number;
  usesBuiltInTools: boolean;
};

export type ModelUsageRow = {
  model: string;
  calls: number;
  totalTokens: number;
  costUsd: number;
  unpricedCalls: number;
  /** Null when this model is not on the rate card — shown as such, not as $0. */
  rates: ModelRates | null;
};

/** Top users by tokens over the reporting window. */
async function topUsers(
  organizationId: string,
  since: Date,
  limit: number,
): Promise<UserUsageRow[]> {
  const grouped = await prisma.aiCallLog.groupBy({
    by: ["userId"],
    where: { organizationId, createdAt: { gte: since } },
    _sum: { totalTokens: true, costUsd: true },
    _count: { _all: true, costUsd: true },
    orderBy: { _sum: { totalTokens: "desc" } },
    take: limit,
  });

  // One extra query for the names of at most `limit` ids, rather than a join
  // that would defeat the grouping. Scoped to the org as well, belt and braces.
  const ids = grouped.map((row) => row.userId).filter((id): id is string => id !== null);
  const users = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids }, organizationId },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(users.map((user) => [user.id, user.name]));

  return grouped.map((row) => ({
    userId: row.userId,
    // A null userId is the scheduled org-wide sweep, not a missing name. It is
    // labelled as the system so its spend is never mistaken for a person's.
    name:
      row.userId === null
        ? "Scheduled jobs (no user)"
        : nameById.get(row.userId) ?? "Removed member",
    calls: row._count._all,
    totalTokens: row._sum.totalTokens ?? 0,
    costUsd: toNumber(row._sum.costUsd) ?? 0,
    unpricedCalls: row._count._all - row._count.costUsd,
  }));
}

async function usageByUseCase(organizationId: string, since: Date): Promise<UseCaseUsageRow[]> {
  const grouped = await prisma.aiCallLog.groupBy({
    by: ["useCase"],
    where: { organizationId, createdAt: { gte: since } },
    _sum: { totalTokens: true, costUsd: true },
    _avg: { costUsd: true },
    _count: { _all: true, costUsd: true },
    orderBy: { _sum: { totalTokens: "desc" } },
  });

  // Which use cases ever offered a provider-executed tool, so the UI can warn
  // that those rows under-report. Counted in SQL, not by scanning rows.
  const withTools = await prisma.aiCallLog.groupBy({
    by: ["useCase"],
    where: { organizationId, createdAt: { gte: since }, usedBuiltInTools: true },
    _count: { _all: true },
  });
  const toolUseCases = new Set(withTools.map((row) => row.useCase));

  return grouped.map((row) => ({
    useCase: row.useCase,
    calls: row._count._all,
    totalTokens: row._sum.totalTokens ?? 0,
    costUsd: toNumber(row._sum.costUsd) ?? 0,
    averageCostUsd: toNumber(row._avg.costUsd),
    unpricedCalls: row._count._all - row._count.costUsd,
    usesBuiltInTools: toolUseCases.has(row.useCase),
  }));
}

async function usageByModel(organizationId: string, since: Date): Promise<ModelUsageRow[]> {
  const grouped = await prisma.aiCallLog.groupBy({
    by: ["model"],
    where: { organizationId, createdAt: { gte: since } },
    _sum: { totalTokens: true, costUsd: true },
    _count: { _all: true, costUsd: true },
    orderBy: { _sum: { totalTokens: "desc" } },
  });

  return grouped.map((row) => ({
    model: row.model,
    calls: row._count._all,
    totalTokens: row._sum.totalTokens ?? 0,
    costUsd: toNumber(row._sum.costUsd) ?? 0,
    unpricedCalls: row._count._all - row._count.costUsd,
    // The CURRENT card, which is what a rate table should show. It can differ
    // from the frozen per-row rates that priced older calls — that is the point
    // of storing them per row.
    rates: getModelRates(row.model),
  }));
}

export type AiAuditSummary = {
  windows: WindowTotals[];
  topUsers: UserUsageRow[];
  useCases: UseCaseUsageRow[];
  models: ModelUsageRow[];
  /** The window the distributions cover (this UTC month). */
  distributionSince: string;
};

/** Everything the summary dashboard renders, in one pass. */
export async function loadAiAuditSummary(
  organizationId: string,
  now: Date = new Date(),
): Promise<AiAuditSummary> {
  // The distributions cover the month. A shorter window is usually empty for a
  // team that runs matching weekly, and an empty chart teaches nobody anything.
  const since = windowStart("month", now);

  const [hour, today, week, month, users, useCases, models] = await Promise.all([
    totalsForWindow(organizationId, "hour", now),
    totalsForWindow(organizationId, "today", now),
    totalsForWindow(organizationId, "week", now),
    totalsForWindow(organizationId, "month", now),
    topUsers(organizationId, since, 8),
    usageByUseCase(organizationId, since),
    usageByModel(organizationId, since),
  ]);

  return {
    windows: [hour, today, week, month],
    topUsers: users,
    useCases,
    models,
    distributionSince: since.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export const AI_AUDIT_PAGE_SIZE = 25;

export function parseAiAuditSearchParams(params: Record<string, string | string[] | undefined>) {
  const read = (key: string) => {
    const value = params[key];
    const first = Array.isArray(value) ? value[0] : value;
    return first && first.trim() ? first.trim() : null;
  };

  const rawPage = Number.parseInt(read("page") ?? "1", 10);
  const rawSort = read("sort");
  const sort: AiCallSortKey =
    rawSort === "totalTokens" || rawSort === "costUsd" || rawSort === "latencyMs"
      ? rawSort
      : "createdAt";

  const rawUseCase = read("useCase");
  const rawStatus = read("status");

  return {
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
    sort,
    direction: read("dir") === "asc" ? ("asc" as const) : ("desc" as const),
    filters: {
      // Validated against the enum rather than passed through: an unrecognised
      // value becomes "no filter" instead of reaching Prisma as a bad enum.
      useCase: (rawUseCase && USE_CASES.includes(rawUseCase as AiUseCase)
        ? rawUseCase
        : null) as AiUseCase | null,
      model: read("model"),
      userId: read("userId"),
      status: (rawStatus === "OK" || rawStatus === "ERROR" ? rawStatus : null) as AiCallStatus | null,
    } satisfies AiAuditFilters,
  };
}

function buildWhere(
  organizationId: string,
  filters: AiAuditFilters,
): Prisma.AiCallLogWhereInput {
  return {
    // The tenant is the FIRST clause and is not derived from any filter, so no
    // combination of query parameters can reach another org's rows.
    organizationId,
    ...(filters.useCase ? { useCase: filters.useCase } : {}),
    ...(filters.model ? { model: filters.model } : {}),
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
}

/**
 * One page of the transaction list, plus the total count.
 *
 * Both come from the database. Sorting is server-side so ordering by cost sorts
 * the whole table, not the 25 rows that happen to be on screen. `costUsd` sorts
 * NULLS LAST in both directions: an unknown cost is unknown, not cheapest.
 */
export async function fetchAiCallPage({
  organizationId,
  page,
  sort,
  direction,
  filters,
  pageSize = AI_AUDIT_PAGE_SIZE,
}: {
  organizationId: string;
  page: number;
  sort: AiCallSortKey;
  direction: "asc" | "desc";
  filters: AiAuditFilters;
  pageSize?: number;
}): Promise<{ rows: AiCallRow[]; total: number; page: number; pageCount: number }> {
  const where = buildWhere(organizationId, filters);

  const orderBy: Prisma.AiCallLogOrderByWithRelationInput[] =
    sort === "costUsd"
      ? [{ costUsd: { sort: direction, nulls: "last" } }, { createdAt: "desc" }]
      : [{ [sort]: direction } as Prisma.AiCallLogOrderByWithRelationInput, { createdAt: "desc" }];

  const total = await prisma.aiCallLog.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);

  const rows = await prisma.aiCallLog.findMany({
    where,
    orderBy,
    skip: (safePage - 1) * pageSize,
    take: pageSize,
    select: {
      id: true,
      createdAt: true,
      model: true,
      useCase: true,
      status: true,
      errorKind: true,
      promptTokens: true,
      completionTokens: true,
      totalTokens: true,
      costUsd: true,
      usageReported: true,
      usedBuiltInTools: true,
      latencyMs: true,
      user: { select: { name: true } },
    },
  });

  return {
    rows: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      model: row.model,
      useCase: row.useCase,
      userName: row.user?.name ?? "Scheduled job",
      status: row.status,
      errorKind: row.errorKind,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
      costUsd: toNumber(row.costUsd),
      usageReported: row.usageReported,
      usedBuiltInTools: row.usedBuiltInTools,
      latencyMs: row.latencyMs,
    })),
    total,
    page: safePage,
    pageCount,
  };
}

/** Distinct models and members present in this org's log, for the filter menus. */
export async function loadAiAuditFilterOptions(organizationId: string) {
  const [models, users] = await Promise.all([
    prisma.aiCallLog.groupBy({
      by: ["model"],
      where: { organizationId },
      _count: { _all: true },
      orderBy: { _count: { model: "desc" } },
      take: 25,
    }),
    prisma.user.findMany({
      where: { organizationId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return { models: models.map((row) => row.model), users };
}
