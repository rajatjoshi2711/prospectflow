import { getSignal, type InteractionSignalMap } from "@/lib/insights/signals";

/**
 * Relationship strength, 0-100.
 *
 * The real score lives in `RelationshipStrengthScore` and is produced by the
 * Phase 6 hybrid pipeline (rule-based feature extraction -> LLM scoring +
 * explanation). Until that lands, this module computes a transparent,
 * deterministic heuristic from signals that were genuinely ingested. It never
 * fabricates a number: if the export contained no message or invitation data
 * at all, it returns `null` and the UI renders an explicit "not yet scored"
 * state.
 *
 * TODO(Phase 6): replace `deriveRelationshipStrength` with a lookup against
 * `RelationshipStrengthScore` for the connection, falling back to this
 * heuristic only while a score has not been computed yet. This file is the one
 * place that needs to change.
 */

export type RelationshipStrength = {
  score: number;
  /** Human-readable reasons, shown on hover. */
  factors: string[];
  /** `heuristic` today; `ai` once Phase 6 populates RelationshipStrengthScore. */
  basis: "heuristic";
};

const MAX_MESSAGE_POINTS = 40;
const POINTS_PER_MESSAGE = 4;

export function deriveRelationshipStrength({
  signals,
  name,
  connectedOn,
  now = new Date(),
}: {
  signals: InteractionSignalMap;
  /** `normalizePersonName(firstName, lastName)`. */
  name: string;
  connectedOn?: Date | null;
  now?: Date;
}): RelationshipStrength | null {
  if (!signals.hasAnyInteractionData) {
    // No messages.csv and no Invitations.csv in this import — we genuinely
    // cannot say anything about relationship strength.
    return null;
  }

  const signal = getSignal(signals, name);
  const factors: string[] = [];
  let score = 0;

  const totalMessages = signal.inboundMessages + signal.outboundMessages;
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

function daysBetween(from: Date, to: Date): number {
  return Math.abs(to.getTime() - from.getTime()) / 86_400_000;
}
