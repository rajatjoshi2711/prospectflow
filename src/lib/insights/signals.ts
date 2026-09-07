import { computeNameKeyFromParts } from "@/lib/ingestion/identity-key";

/**
 * Interaction signals extracted from a user's ingested LinkedIn export for a
 * specific set of people.
 *
 * HOW THE JOIN WORKS
 * ------------------
 * Ingestion writes two keys onto every person-bearing row (see
 * `src/lib/ingestion/identity-key.ts`):
 *   - `identityKey` — `url:<normalized profile url>` when a URL is available.
 *   - `nameKey`     — `name:<normalized display name>`, always set when a name
 *                     is known.
 * `MessageRecord` and `Invitation` are keyed to the COUNTERPARTY, not to the
 * account owner, so a connection's whole conversation carries that
 * connection's keys regardless of who sent each message.
 *
 * A connection therefore finds its messages by matching `identityKey` first
 * (exact) and falling back to `nameKey`. The name fallback is inexact: two
 * different people with the same display name share a `nameKey` and their
 * interactions can be merged. It is the only join a name-only export row
 * supports, and it is the reason relationship strength is presented as a
 * heuristic rather than a fact.
 */
export type InteractionSignal = {
  /** Messages this person sent to the account owner. */
  inboundMessages: number;
  /** Messages the account owner sent to this person. */
  outboundMessages: number;
  /**
   * Messages on this person's threads whose direction could not be determined
   * (legacy rows, or an export where the owner's name matched neither party).
   */
  undirectedMessages: number;
  /** Most recent message in either direction, if any. */
  lastMessageAt: Date | null;
  /** An invitation record exists for this person. */
  hasInvitation: boolean;
  /** The invitation carried a personal note (a stronger relationship signal). */
  hasInvitationNote: boolean;
};

/**
 * Identifies one person on the rendering side of the join. `identityKey` is
 * the connection's own key and doubles as the map key in `byKey`.
 */
export type PersonRef = {
  identityKey: string;
  nameKey: string | null;
};

export type InteractionSignalMap = {
  /** Keyed by the connection's `identityKey`. */
  byKey: Map<string, InteractionSignal>;
  /**
   * False when the import contained no messages.csv and no Invitations.csv at
   * all — in that case an absent signal means "we have no data", not "no
   * relationship", and callers must render a "not yet scored" state rather
   * than a zero.
   */
  hasAnyInteractionData: boolean;
};

const EMPTY_SIGNAL: InteractionSignal = {
  inboundMessages: 0,
  outboundMessages: 0,
  undirectedMessages: 0,
  lastMessageAt: null,
  hasInvitation: false,
  hasInvitationNote: false,
};

/**
 * Builds the join keys for a connection row. `nameKey` is recomputed from the
 * name columns when the stored column is null, so connections imported before
 * the `nameKey` column existed still join.
 */
export function toPersonRef(connection: {
  identityKey: string;
  nameKey?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): PersonRef {
  return {
    identityKey: connection.identityKey,
    nameKey:
      connection.nameKey ?? computeNameKeyFromParts(connection.firstName, connection.lastName),
  };
}

export function getSignal(
  signals: InteractionSignalMap,
  identityKey: string,
): InteractionSignal {
  return signals.byKey.get(identityKey) ?? EMPTY_SIGNAL;
}

export function blankSignal(): InteractionSignal {
  return { ...EMPTY_SIGNAL };
}
