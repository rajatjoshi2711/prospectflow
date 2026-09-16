import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { tryGetLLMProvider } from "@/lib/ai";
import { deriveRelationshipStrength } from "@/lib/insights/relationship";
import { blankSignal, type InteractionSignalMap } from "@/lib/insights/signals";
import { getLatestCompleteBatch } from "@/lib/insights/prospects";
import { computeNameKeyFromParts } from "@/lib/ingestion/identity-key";
import {
  buildFeatures,
  detectCallSignal,
  emptyFeatures,
  evidenceWeight,
  hasMeaningfulSignal,
  type MessageFact,
  type RelationshipFeatures,
} from "@/lib/relationship/features";
import {
  scoreRelationships,
  type RelationshipCandidate,
} from "@/lib/relationship/score";

/**
 * Recomputes `RelationshipStrengthScore` for one user's current snapshot.
 *
 * SHAPE OF A RUN
 *   1. Resolve the user's latest COMPLETE import batch — the same "current
 *      snapshot" every dashboard reads from.
 *   2. Load that batch's messages and invitations ONCE, without bodies, and
 *      fold them into per-counterparty aggregates (pure CPU).
 *   3. Join those aggregates onto the batch's connections by `identityKey`
 *      with a `nameKey` fallback (the join `src/lib/insights/signals.ts`
 *      documents).
 *   4. Drop everyone with no signal at all — they are deliberately left
 *      UNSCORED so the UI can say "not yet scored" instead of showing a fake
 *      zero — and cap the rest at `MAX_SCORED_PER_USER` by evidence weight.
 *   5. Fetch message bodies for ONLY that capped set, to run the call-scheduled
 *      detector.
 *   6. Score in batches (LLM, or deterministic when no provider), upsert, and
 *      prune rows for connections that are no longer scorable.
 *   7. Materialize the EFFECTIVE strength onto every connection in the batch
 *      (`Connection.relationshipScore` / `relationshipBasis`) so the dashboards
 *      can order by it in SQL. See `materializeEffectiveScores`.
 *
 * COST
 *   The number of model calls is bounded by the cap, not by network size:
 *   ceil(MAX_SCORED_PER_USER / 15) calls per user per run — 27 at the current
 *   settings — whether the user has 300 connections or 30,000. Connections with
 *   zero messages never reach the model at all, and in a typical LinkedIn export
 *   that is the large majority of them.
 */

/**
 * Hard cap on people scored per user per run. Ranked by evidence weight, so the
 * cap drops the thinnest relationships first — exactly the ones whose score
 * matters least.
 */
const MAX_SCORED_PER_USER = 400;

/**
 * Safety cap on message rows folded in one run. Far above a realistic export;
 * it exists so a pathological account cannot pull an unbounded result set into
 * the function's memory.
 */
const MAX_MESSAGE_ROWS = 200_000;
const MAX_INVITATION_ROWS = 50_000;
/** Bodies are only fetched for the capped shortlist, and only to detect calls. */
const MAX_BODY_ROWS = 20_000;

export type RelationshipRunSummary = {
  userId: string;
  status: "scored" | "no-import" | "no-signal";
  batchId: string | null;
  connectionsConsidered: number;
  scorable: number;
  scored: number;
  pruned: number;
  llmCalls: number;
  degradedBatches: number;
  /** True when no LLM was configured and every score is rules-only. */
  heuristicOnly: boolean;
};

type Aggregate = {
  messages: MessageFact[];
  hasInvitation: boolean;
  hasInvitationNote: boolean;
};

function blankAggregate(): Aggregate {
  return { messages: [], hasInvitation: false, hasInvitationNote: false };
}

/**
 * Public entry point. Runs the scoring pass, then stamps
 * `User.relationshipScoreComputedAt` on EVERY exit path — including the
 * no-import and no-signal ones, which are finished runs too, just with nothing
 * to write.
 *
 * That stamp is what lets the dashboard say "scoring is running" honestly:
 * paired with `relationshipScoreRequestedAt` it distinguishes "the job has not
 * finished yet" from "the job finished and found no interaction data". Without
 * it, an empty score table means both things at once and the UI has to guess.
 *
 * The stamp is written even when the run throws, so a permanently failing job
 * cannot leave the UI spinning forever; the error is re-thrown afterwards so
 * Inngest still sees the failure and retries.
 */
export async function computeRelationshipScoresForUser(
  userId: string,
): Promise<RelationshipRunSummary> {
  try {
    return await runScoring(userId);
  } finally {
    await markScoringComputed(userId);
  }
}

/**
 * Records that a scoring run finished for this user.
 *
 * Best-effort: the scores themselves are already committed by this point, and
 * failing the whole run because a timestamp did not write would throw away real
 * work. A missed stamp degrades to the UI's "taking longer than expected" state,
 * which is a nudge, not a lie.
 */
async function markScoringComputed(userId: string): Promise<void> {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { relationshipScoreComputedAt: new Date() },
    });
  } catch (error) {
    console.error("Failed to stamp relationshipScoreComputedAt", { userId, error });
  }
}

async function runScoring(userId: string): Promise<RelationshipRunSummary> {
  const base: RelationshipRunSummary = {
    userId,
    status: "no-import",
    batchId: null,
    connectionsConsidered: 0,
    scorable: 0,
    scored: 0,
    pruned: 0,
    llmCalls: 0,
    degradedBatches: 0,
    heuristicOnly: false,
  };

  const batch = await getLatestCompleteBatch(userId);
  if (!batch) return base;

  const connections = await prisma.connection.findMany({
    where: { importBatchId: batch.id },
    select: {
      id: true,
      identityKey: true,
      nameKey: true,
      firstName: true,
      lastName: true,
      company: true,
      position: true,
      connectedOn: true,
    },
  });

  if (connections.length === 0) {
    return { ...base, status: "no-signal", batchId: batch.id };
  }

  // identityKey / nameKey -> connection id. First writer wins on the weak name
  // key, matching `loadInteractionSignals`: two people sharing a display name
  // cannot be told apart, so their rows go to one of them rather than being
  // double-counted onto both.
  const byIdentity = new Map<string, string>();
  const byNameKey = new Map<string, string>();
  for (const connection of connections) {
    byIdentity.set(connection.identityKey, connection.id);
    const nameKey =
      connection.nameKey ?? computeNameKeyFromParts(connection.firstName, connection.lastName);
    if (nameKey && !byNameKey.has(nameKey)) byNameKey.set(nameKey, connection.id);
  }

  const resolve = (row: { identityKey: string; nameKey: string | null }): string | undefined =>
    byIdentity.get(row.identityKey) ?? (row.nameKey ? byNameKey.get(row.nameKey) : undefined);

  // Bodies are deliberately NOT selected here — this query spans the whole
  // batch, and message text is only needed for the small capped shortlist.
  const [messages, invitations] = await Promise.all([
    prisma.messageRecord.findMany({
      where: { importBatchId: batch.id },
      take: MAX_MESSAGE_ROWS,
      select: {
        identityKey: true,
        nameKey: true,
        senderIsUser: true,
        sentAt: true,
        conversationId: true,
      },
    }),
    prisma.invitation.findMany({
      where: { importBatchId: batch.id },
      take: MAX_INVITATION_ROWS,
      select: { identityKey: true, nameKey: true, message: true },
    }),
  ]);

  const aggregates = new Map<string, Aggregate>();
  for (const message of messages) {
    const connectionId = resolve(message);
    if (!connectionId) continue;
    const aggregate = aggregates.get(connectionId) ?? blankAggregate();
    aggregate.messages.push({
      senderIsUser: message.senderIsUser,
      sentAt: message.sentAt,
      conversationId: message.conversationId,
    });
    aggregates.set(connectionId, aggregate);
  }
  for (const invitation of invitations) {
    const connectionId = resolve(invitation);
    if (!connectionId) continue;
    const aggregate = aggregates.get(connectionId) ?? blankAggregate();
    aggregate.hasInvitation = true;
    if ((invitation.message ?? "").trim().length > 0) aggregate.hasInvitationNote = true;
    aggregates.set(connectionId, aggregate);
  }

  const now = new Date();
  const hasAnyInteractionData = messages.length > 0 || invitations.length > 0;
  const featuresById = new Map<string, RelationshipFeatures>();
  for (const connection of connections) {
    const aggregate = aggregates.get(connection.id);
    if (!aggregate) continue; // no signal at all -> deliberately unscored
    featuresById.set(
      connection.id,
      buildFeatures({
        messages: aggregate.messages,
        callSignal: null, // filled in below, for the shortlist only
        hasInvitation: aggregate.hasInvitation,
        hasInvitationNote: aggregate.hasInvitationNote,
        connectedOn: connection.connectedOn,
        now,
      }),
    );
  }

  const scorableIds = [...featuresById.entries()]
    .filter(([, features]) => hasMeaningfulSignal(features))
    .sort((a, b) => evidenceWeight(b[1]) - evidenceWeight(a[1]))
    .slice(0, MAX_SCORED_PER_USER)
    .map(([connectionId]) => connectionId);

  const summary: RelationshipRunSummary = {
    ...base,
    status: scorableIds.length === 0 ? "no-signal" : "scored",
    batchId: batch.id,
    connectionsConsidered: connections.length,
    scorable: scorableIds.length,
  };

  if (scorableIds.length === 0) {
    // Nothing to score. Still prune, so scores from a previous snapshot do not
    // linger against connections that now have no evidence behind them, and
    // still materialize — an unscorable batch is a real answer ("not yet
    // scored" everywhere), not a reason to leave the sort column stale.
    summary.pruned = await pruneScores(userId, []);
    await materializeEffectiveScores({
      batchId: batch.id,
      connections,
      aggregates,
      hasAnyInteractionData,
      aiScores: new Map(),
      now,
    });
    return summary;
  }

  const shortlisted = new Set(scorableIds);
  const shortlistedConnections = connections.filter((connection) =>
    shortlisted.has(connection.id),
  );

  // Bodies, for the call-scheduled detector only — restricted to the shortlist's
  // keys so the text never leaves this function for anyone else.
  await applyCallSignals({
    importBatchId: batch.id,
    connections: shortlistedConnections,
    resolve,
    featuresById,
  });

  const candidates: RelationshipCandidate[] = shortlistedConnections.map((connection) => ({
    connectionId: connection.id,
    name: [connection.firstName, connection.lastName].filter(Boolean).join(" ").trim(),
    company: connection.company,
    position: connection.position,
    features: featuresById.get(connection.id) ?? emptyFeatures(),
  }));

  // The run is keyed by user, but AI spend is accounted per ORG, so the tenant
  // is resolved here rather than threaded through every caller. Looked up only
  // when there is actually something to score, so the no-import and no-signal
  // exits above still cost nothing.
  const owner = await prisma.user.findUnique({
    where: { id: userId },
    select: { organizationId: true },
  });

  // No org means the user was deleted while the job was in flight. Fall back to
  // the deterministic path rather than spending money that cannot be attributed
  // to any tenant — an unattributable row can never be shown to an admin.
  const provider = owner ? tryGetLLMProvider() : null;
  summary.heuristicOnly = provider === null;

  const { scored, llmCalls, degradedBatches } = await scoreRelationships({
    provider,
    context: {
      organizationId: owner?.organizationId ?? "",
      userId,
      useCase: "RELATIONSHIP_SCORING",
    },
    candidates,
  });
  summary.llmCalls = llmCalls;
  summary.degradedBatches = degradedBatches;

  for (const result of scored) {
    const features = featuresById.get(result.connectionId) ?? emptyFeatures();
    const factors = {
      // The full extracted feature set, so a score is always explainable from
      // stored data without re-reading the export.
      features,
      reasons: result.reasons,
      rationale: result.rationale,
      basis: result.basis,
      importBatchId: batch.id,
    };
    await prisma.relationshipStrengthScore.upsert({
      where: { userId_connectionId: { userId, connectionId: result.connectionId } },
      create: {
        userId,
        connectionId: result.connectionId,
        score: result.score,
        factors,
        basis: result.basis,
      },
      update: {
        score: result.score,
        factors,
        basis: result.basis,
        computedAt: new Date(),
      },
    });
  }
  summary.scored = scored.length;
  summary.pruned = await pruneScores(userId, scored.map((result) => result.connectionId));

  await materializeEffectiveScores({
    batchId: batch.id,
    connections,
    aggregates,
    hasAnyInteractionData,
    aiScores: new Map(
      scored.map((result) => [result.connectionId, { score: result.score, basis: result.basis }]),
    ),
    now,
  });

  return summary;
}

/** How many connections get their score written per round trip. */
const MATERIALIZE_CHUNK = 500;

/**
 * Writes the EFFECTIVE relationship strength onto every connection in the
 * batch, so `ORDER BY` can see the same number the table renders.
 *
 * WHY EVERY CONNECTION AND NOT JUST THE SCORED ONES
 * -------------------------------------------------
 * Only a capped subset (`MAX_SCORED_PER_USER`) ever gets a
 * `RelationshipStrengthScore` row; everyone else displays the deterministic
 * read-time heuristic. Ordering by the score table alone would therefore sort
 * a few hundred people and strand the rest, producing an order that
 * contradicts the numbers on screen. So the resolution order the UI uses —
 * model score, else heuristic, else unknown — is applied here once, for the
 * whole batch, and the answer is stored.
 *
 * NULL IS NOT ZERO
 * ----------------
 * `deriveRelationshipStrength` returns null exactly when the import carried no
 * messages and no invitations at all, and that null is written through as
 * null. A 0 would claim "weak relationship" where the truth is "no data", and
 * would sort those people above nobody rather than last.
 *
 * COST
 * ----
 * No new queries: the heuristic is computed from the per-connection aggregates
 * the run has already folded in memory, so this adds CPU proportional to the
 * batch and `ceil(connections / 500)` UPDATE statements — roughly 60 round
 * trips for a 30,000-connection export. Every row is rewritten rather than
 * diffed, because the heuristic's recency terms decay with wall-clock time, so
 * "unchanged since last run" is not a property this can rely on.
 */
async function materializeEffectiveScores({
  batchId,
  connections,
  aggregates,
  hasAnyInteractionData,
  aiScores,
  now,
}: {
  batchId: string;
  connections: {
    id: string;
    identityKey: string;
    connectedOn: Date | null;
  }[];
  aggregates: Map<string, Aggregate>;
  hasAnyInteractionData: boolean;
  aiScores: Map<string, { score: number; basis: "ai" | "heuristic" }>;
  now: Date;
}): Promise<void> {
  if (connections.length === 0) return;

  // The read-time heuristic takes an `InteractionSignalMap` keyed by the
  // connection's identityKey. The aggregates already hold the same facts for
  // the whole batch, so rebuild that shape here rather than re-querying: this
  // is the only way the stored number is guaranteed to equal what a page would
  // have rendered from `loadInteractionSignals`.
  const signals: InteractionSignalMap = { byKey: new Map(), hasAnyInteractionData };
  for (const connection of connections) {
    const aggregate = aggregates.get(connection.id);
    if (!aggregate) continue;
    const signal = blankSignal();
    for (const message of aggregate.messages) {
      if (message.senderIsUser === true) signal.outboundMessages += 1;
      else if (message.senderIsUser === false) signal.inboundMessages += 1;
      else signal.undirectedMessages += 1;
      if (message.sentAt && (!signal.lastMessageAt || message.sentAt > signal.lastMessageAt)) {
        signal.lastMessageAt = message.sentAt;
      }
    }
    signal.hasInvitation = aggregate.hasInvitation;
    signal.hasInvitationNote = aggregate.hasInvitationNote;
    signals.byKey.set(connection.identityKey, signal);
  }

  const values = connections.map((connection) => {
    const ai = aiScores.get(connection.id);
    if (ai) return { id: connection.id, score: ai.score, basis: ai.basis };
    const heuristic = deriveRelationshipStrength({
      signals,
      identityKey: connection.identityKey,
      connectedOn: connection.connectedOn,
      stored: null,
      now,
    });
    return heuristic
      ? { id: connection.id, score: heuristic.score, basis: heuristic.basis }
      : { id: connection.id, score: null, basis: null };
  });

  for (let index = 0; index < values.length; index += MATERIALIZE_CHUNK) {
    const chunk = values.slice(index, index + MATERIALIZE_CHUNK);
    // A single UPDATE ... FROM (VALUES ...) per chunk. Fully parameterized —
    // every id, score and basis is a bind variable, never interpolated text —
    // with explicit casts because Postgres cannot infer a VALUES column's type
    // from parameters alone. The `importBatchId` guard keeps the write inside
    // the batch this run resolved, so a stale id can never reach another
    // user's rows.
    const rows = chunk.map(
      (value) =>
        Prisma.sql`(${value.id}::text, ${value.score}::int, ${value.basis}::text)`,
    );
    await prisma.$executeRaw`
      UPDATE "Connection" AS c
      SET "relationshipScore" = v.score, "relationshipBasis" = v.basis
      FROM (VALUES ${Prisma.join(rows)}) AS v(id, score, basis)
      WHERE c.id = v.id AND c."importBatchId" = ${batchId}
    `;
  }
}

/**
 * Fetches message bodies for the shortlist and records which relationships show
 * a scheduled call.
 *
 * Split out so the expensive-ish text query is obviously bounded: it runs only
 * against the shortlist's own keys, and only after the cap has been applied.
 */
async function applyCallSignals({
  importBatchId,
  connections,
  resolve,
  featuresById,
}: {
  importBatchId: string;
  connections: {
    id: string;
    identityKey: string;
    nameKey: string | null;
    firstName: string | null;
    lastName: string | null;
  }[];
  resolve: (row: { identityKey: string; nameKey: string | null }) => string | undefined;
  featuresById: Map<string, RelationshipFeatures>;
}): Promise<void> {
  if (connections.length === 0) return;

  const identityKeys = connections.map((connection) => connection.identityKey);
  const nameKeys = connections
    .map(
      (connection) =>
        connection.nameKey ?? computeNameKeyFromParts(connection.firstName, connection.lastName),
    )
    .filter((key): key is string => key !== null);

  const bodies = await prisma.messageRecord.findMany({
    where: {
      importBatchId,
      OR: [{ identityKey: { in: identityKeys } }, { nameKey: { in: nameKeys } }],
      content: { not: null },
    },
    take: MAX_BODY_ROWS,
    select: { identityKey: true, nameKey: true, content: true },
  });

  for (const body of bodies) {
    const connectionId = resolve(body);
    if (!connectionId) continue;
    const features = featuresById.get(connectionId);
    if (!features || features.callScheduled) continue;
    const signal = detectCallSignal(body.content);
    if (signal) {
      features.callScheduled = true;
      features.callSignal = signal;
    }
  }
}

/**
 * Deletes this user's scores for any connection not in `keepIds`.
 *
 * Covers both "the connection dropped out of the latest export" and "there is
 * no longer any evidence behind the score". Without this a stale number would
 * outlive the data it was derived from, which is exactly the fabrication the
 * rest of the pipeline is careful to avoid.
 */
async function pruneScores(userId: string, keepIds: string[]): Promise<number> {
  const result = await prisma.relationshipStrengthScore.deleteMany({
    where: {
      userId,
      ...(keepIds.length > 0 ? { connectionId: { notIn: keepIds } } : {}),
    },
  });
  return result.count;
}
