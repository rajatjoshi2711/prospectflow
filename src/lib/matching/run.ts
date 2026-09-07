import "server-only";

import type { MatchType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { tryGetLLMProvider } from "@/lib/ai";
import { getLatestCompleteBatch } from "@/lib/insights/prospects";
import {
  buildVocabulary,
  shortlist,
  type CandidateConnection,
  type MatchDefinition,
} from "@/lib/matching/prefilter";
import { scoreShortlist } from "@/lib/matching/score";

/**
 * Orchestrates ICP / channel-partner matching for one user's current snapshot.
 *
 * SHAPE OF A RUN
 * --------------
 *   1. Resolve the user's latest COMPLETE import batch. Everything is scored
 *      against that one batch, matching the "current snapshot" convention the
 *      dashboards already use.
 *   2. Load the org's ICPs and channel partners once.
 *   3. Load the batch's connections once (a single query, capped), then run
 *      the CPU-only pre-filter per definition over that in-memory list.
 *   4. Send only each definition's bounded shortlist to the LLM, in batches.
 *   5. Upsert the results and prune anything stale.
 *
 * IDEMPOTENCY: writes go through `upsert` on the unique (connection,
 * definition) pair, and every row for this batch/definition that is NOT in the
 * new result set is deleted. Running this ten times in a row produces exactly
 * the same table as running it once.
 */

/** Below this the match is not worth a row — the dashboards would hide it anyway. */
const MIN_PERSISTED_SCORE = 40;

/**
 * Safety cap on connections considered in one run. Well above a realistic
 * LinkedIn network; it exists so a pathological account cannot pull an
 * unbounded result set into the function's memory.
 */
const MAX_CONNECTIONS = 25_000;

export type MatchRunSummary = {
  userId: string;
  status: "scored" | "no-import" | "no-definitions";
  batchId: string | null;
  connectionsConsidered: number;
  definitionsConsidered: number;
  shortlisted: number;
  matchesWritten: number;
  matchesPruned: number;
  llmCalls: number;
  degradedBatches: number;
  /** True when no LLM was configured and every score is rules-only. */
  heuristicOnly: boolean;
};

function toDefinition(
  icp: {
    id: string;
    name: string;
    country: string | null;
    industry: string | null;
    positions: string[];
    description: string | null;
  },
): MatchDefinition {
  return { ...icp, kind: "ICP" };
}

function toPartnerDefinition(partner: {
  id: string;
  name: string;
  industry: string | null;
  criteria: string | null;
}): MatchDefinition {
  return {
    id: partner.id,
    kind: "CHANNEL_PARTNER",
    name: partner.name,
    country: null,
    industry: partner.industry,
    positions: [],
    description: partner.criteria,
  };
}

/**
 * Loads the org's definitions, optionally narrowed to specific ids (used when
 * an admin saves one ICP and only that one needs re-scoring).
 */
async function loadDefinitions(
  organizationId: string,
  only?: { icpIds?: string[]; channelPartnerIds?: string[] },
): Promise<MatchDefinition[]> {
  const scoped = only?.icpIds !== undefined || only?.channelPartnerIds !== undefined;

  const [icps, partners] = await Promise.all([
    scoped && (only?.icpIds ?? []).length === 0
      ? Promise.resolve([])
      : prisma.iCP.findMany({
          where: {
            organizationId,
            ...(only?.icpIds ? { id: { in: only.icpIds } } : {}),
          },
          select: {
            id: true,
            name: true,
            country: true,
            industry: true,
            positions: true,
            description: true,
          },
        }),
    scoped && (only?.channelPartnerIds ?? []).length === 0
      ? Promise.resolve([])
      : prisma.channelPartner.findMany({
          where: {
            organizationId,
            ...(only?.channelPartnerIds ? { id: { in: only.channelPartnerIds } } : {}),
          },
          select: { id: true, name: true, industry: true, criteria: true },
        }),
  ]);

  return [...icps.map(toDefinition), ...partners.map(toPartnerDefinition)];
}

export async function computeMatchesForUser({
  userId,
  organizationId,
  only,
}: {
  userId: string;
  organizationId: string;
  only?: { icpIds?: string[]; channelPartnerIds?: string[] };
}): Promise<MatchRunSummary> {
  const base: MatchRunSummary = {
    userId,
    status: "no-import",
    batchId: null,
    connectionsConsidered: 0,
    definitionsConsidered: 0,
    shortlisted: 0,
    matchesWritten: 0,
    matchesPruned: 0,
    llmCalls: 0,
    degradedBatches: 0,
    heuristicOnly: false,
  };

  const batch = await getLatestCompleteBatch(userId);
  if (!batch) return base;

  const definitions = await loadDefinitions(organizationId, only);
  if (definitions.length === 0) {
    return { ...base, status: "no-definitions", batchId: batch.id };
  }

  const connections: CandidateConnection[] = await prisma.connection.findMany({
    where: { importBatchId: batch.id },
    take: MAX_CONNECTIONS,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      company: true,
      position: true,
      country: true,
    },
  });

  // Resolved once per run, not once per definition. Null means "no
  // GROQ_API_KEY / unknown provider" — matching still runs, on rules alone.
  const provider = tryGetLLMProvider();

  const summary: MatchRunSummary = {
    ...base,
    status: "scored",
    batchId: batch.id,
    connectionsConsidered: connections.length,
    definitionsConsidered: definitions.length,
    heuristicOnly: provider === null,
  };

  for (const definition of definitions) {
    const hits = shortlist(buildVocabulary(definition), connections);
    summary.shortlisted += hits.length;

    const { scored, llmCalls, degradedBatches } = await scoreShortlist({
      provider,
      definition,
      hits,
    });
    summary.llmCalls += llmCalls;
    summary.degradedBatches += degradedBatches;

    const keep = scored.filter((result) => result.score >= MIN_PERSISTED_SCORE);
    const matchType: MatchType = definition.kind === "ICP" ? "ICP" : "CHANNEL_PARTNER";
    const definitionWhere =
      definition.kind === "ICP"
        ? { icpId: definition.id }
        : { channelPartnerId: definition.id };

    for (const result of keep) {
      await prisma.prospectMatch.upsert({
        where:
          definition.kind === "ICP"
            ? { connectionId_icpId: { connectionId: result.connectionId, icpId: definition.id } }
            : {
                connectionId_channelPartnerId: {
                  connectionId: result.connectionId,
                  channelPartnerId: definition.id,
                },
              },
        create: {
          connectionId: result.connectionId,
          matchType,
          ...definitionWhere,
          score: result.score,
          rationale: result.rationale,
        },
        update: { score: result.score, rationale: result.rationale, matchType },
      });
    }
    summary.matchesWritten += keep.length;

    // Prune: anything previously stored for this definition against this
    // user's connections that did not survive this run. Covers both "no longer
    // a match" and "connection dropped out of the latest export".
    const keepIds = keep.map((result) => result.connectionId);
    const pruned = await prisma.prospectMatch.deleteMany({
      where: {
        ...definitionWhere,
        connection: { importBatch: { userId } },
        ...(keepIds.length > 0 ? { connectionId: { notIn: keepIds } } : {}),
      },
    });
    summary.matchesPruned += pruned.count;
  }

  return summary;
}

/** Every member of an org, scored in sequence. */
export async function listOrganizationUserIds(organizationId: string): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { organizationId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return users.map((user) => user.id);
}
