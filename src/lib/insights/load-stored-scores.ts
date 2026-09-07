import "server-only";

import { prisma } from "@/lib/prisma";
import type { StoredRelationshipScore } from "@/lib/insights/relationship";

/**
 * Loads stored `RelationshipStrengthScore` rows for a bounded set of
 * connections. Call it with the page of rows actually being rendered (tens),
 * exactly like `loadInteractionSignals`.
 *
 * SCOPING: always filtered by `userId` as well as `connectionId`. A score
 * belongs to one member's reading of their own network; another member's score
 * for the same person is a different row and must never be shown here.
 *
 * A missing entry is not an error — it means the scoring job has not reached
 * that connection (or deliberately skipped it for having no signal), and the
 * caller falls back to the heuristic or to "not yet scored".
 */
export async function loadStoredRelationshipScores(
  userId: string,
  connectionIds: string[],
): Promise<Map<string, StoredRelationshipScore>> {
  const byConnectionId = new Map<string, StoredRelationshipScore>();
  if (connectionIds.length === 0) return byConnectionId;

  const rows = await prisma.relationshipStrengthScore.findMany({
    where: { userId, connectionId: { in: connectionIds } },
    select: { connectionId: true, score: true, factors: true, basis: true },
  });

  for (const row of rows) {
    byConnectionId.set(row.connectionId, {
      score: row.score,
      factors: readReasons(row.factors),
      basis: row.basis === "ai" ? "ai" : "heuristic",
    });
  }
  return byConnectionId;
}

/**
 * `factors` is a Json column written by the scoring pipeline as
 * `{ features, reasons, rationale, basis, importBatchId }`. Read defensively:
 * a row written by an older shape must degrade to "no reasons", never crash a
 * dashboard.
 */
function readReasons(factors: unknown): string[] {
  if (!factors || typeof factors !== "object") return [];
  const record = factors as { reasons?: unknown; rationale?: unknown };
  const reasons = Array.isArray(record.reasons)
    ? record.reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  // The model's one-sentence rationale leads, because it is the part that
  // explains the number rather than listing its inputs.
  if (typeof record.rationale === "string" && record.rationale.trim().length > 0) {
    return [record.rationale.trim(), ...reasons];
  }
  return reasons;
}
