import { getSignal, type InteractionSignalMap } from "@/lib/insights/signals";

/**
 * Relationship strength, 0-100.
 *
 * THREE OUTCOMES, and the distinction between them is the whole point:
 *
 *   1. A stored `RelationshipStrengthScore` exists  -> return it, basis `ai`
 *      (or `heuristic` if the pipeline itself degraded). Produced by the Phase 6
 *      hybrid pipeline in `src/lib/relationship`.
 *   2. No stored score, but this import DID carry interaction data -> fall back
 *      to the transparent deterministic heuristic below, basis `heuristic`. This
 *      covers the window between an import completing and the scoring job
 *      finishing, and the tail of connections beyond the scoring job's cap.
 *   3. No stored score and no interaction data at all -> `null`, and the UI
 *      renders an explicit "not yet scored" state.
 *
 * Outcome 3 is load-bearing: a connection we know nothing about must never be
 * shown as a zero, because zero reads as "a bad relationship" rather than "no
 * data". Every caller treats `null` as unknown.
 *
 * This is the single place any surface derives relationship strength, so the
 * connections, ICP, channel-partner and campaign views all upgraded together
 * when the stored score landed.
 */

export type RelationshipStrength = {
  score: number;
  /** Human-readable reasons, shown on hover. */
  factors: string[];
  /** `ai` when a stored model-produced score was used, `heuristic` otherwise. */
  basis: "heuristic" | "ai";
};

/**
 * A stored score, as loaded by `loadStoredRelationshipScores`. Kept structural
 * (rather than importing the Prisma row type) so this module stays pure and
 * usable from anywhere.
 */
export type StoredRelationshipScore = {
  score: number;
  factors: string[];
  basis: "heuristic" | "ai";
};

const MAX_MESSAGE_POINTS = 40;
const POINTS_PER_MESSAGE = 4;

export function deriveRelationshipStrength({
  signals,
  identityKey,
  connectedOn,
  stored,
  now = new Date(),
}: {
  signals: InteractionSignalMap;
  /** The connection's `identityKey` (see `toPersonRef`). */
  identityKey: string;
  connectedOn?: Date | null;
  /**
   * The stored score for this connection, when one has been computed. Always
   * wins over the heuristic — it was produced from strictly more information
   * (reply ratios, thread structure, call detection) than this function sees.
   */
  stored?: StoredRelationshipScore | null;
  now?: Date;
}): RelationshipStrength | null {
  if (stored) {
    return {
      score: Math.max(0, Math.min(100, Math.round(stored.score))),
      factors: stored.factors.length > 0 ? stored.factors : ["Scored from interaction history"],
      basis: stored.basis,
    };
  }

  if (!signals.hasAnyInteractionData) {
    // No messages.csv and no Invitations.csv in this import — we genuinely
    // cannot say anything about relationship strength.
    return null;
  }

  const signal = getSignal(signals, identityKey);
  const factors: string[] = [];
  let score = 0;

  const totalMessages =
    signal.inboundMessages + signal.outboundMessages + signal.undirectedMessages;
  if (totalMessages > 0) {
    const points = Math.min(MAX_MESSAGE_POINTS, totalMessages * POINTS_PER_MESSAGE);
    score += points;
    factors.push(`${totalMessages} message${totalMessages === 1 ? "" : "s"} exchanged`);
  }

  if (signal.inboundMessages > 0 && signal.outboundMessages > 0) {
    score += 25;
    factors.push("Two-way conversation");
  } else if (signal.inboundMessages > 0) {
    score += 10;
    factors.push("They reached out");
  }

  if (signal.lastMessageAt) {
    const days = daysBetween(signal.lastMessageAt, now);
    if (days <= 90) {
      score += 20;
      factors.push("Messaged in the last 90 days");
    } else if (days <= 365) {
      score += 10;
      factors.push("Messaged in the last year");
    }
  }

  if (connectedOn) {
    const days = daysBetween(connectedOn, now);
    if (days >= 730) {
      score += 10;
      factors.push("Connected for 2+ years");
    } else if (days >= 365) {
      score += 5;
      factors.push("Connected for 1+ year");
    }
  }

  if (signal.hasInvitationNote) {
    score += 5;
    factors.push("Invitation included a personal note");
  }

  if (factors.length === 0) {
    factors.push("No interaction found in this import");
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    factors,
    basis: "heuristic",
  };
}

/**
 * Reconciles the materialized `Connection.relationshipScore` column with the
 * read-time derivation above.
 *
 * The column is what SQL sorts and pages by, so whenever it holds a value the
 * table must display THAT number — otherwise the order on screen contradicts
 * the numbers on screen, which is the exact failure this column was added to
 * fix. The derivation is still run, for two reasons: it supplies the hover
 * factors (the column stores a bare number), and it is the fallback for rows no
 * scoring run has reached yet, so a freshly imported batch reads exactly as it
 * did before this column existed.
 *
 * A null column is "unknown", never "zero" — see the header comment.
 */
export function resolveRelationshipStrength({
  materialized,
  derived,
}: {
  materialized: { score: number | null; basis: string | null };
  derived: RelationshipStrength | null;
}): RelationshipStrength | null {
  if (materialized.score === null) return derived;
  return {
    score: Math.max(0, Math.min(100, Math.round(materialized.score))),
    // The column's own basis wins: it records how the stored number was
    // produced, and the derivation may have fallen back to the heuristic for a
    // connection whose materialized value came from the model.
    basis: materialized.basis === "ai" ? "ai" : "heuristic",
    factors:
      derived && derived.factors.length > 0
        ? derived.factors
        : ["Scored from interaction history"],
  };
}

function daysBetween(from: Date, to: Date): number {
  return Math.abs(to.getTime() - from.getTime()) / 86_400_000;
}
