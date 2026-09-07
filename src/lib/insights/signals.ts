/**
 * Interaction signals extracted from a user's ingested LinkedIn export for a
 * specific set of people.
 *
 * WHY THIS IS NAME-KEYED AND NOT identityKey-KEYED
 * ------------------------------------------------
 * Phase 2 computes `identityKey` differently per CSV:
 *   - Connection  -> `url:<normalized linkedin url>` whenever Connections.csv
 *                    has a URL column (which it almost always does).
 *   - Message     -> `fallback:sha256(<the "From" display name>)`.
 *   - Invitation  -> `fallback:sha256(<the counterparty display name>)`.
 * Those key spaces never intersect, so joining connections to messages or
 * invitations on `identityKey` yields zero rows in practice. Until the
 * ingestion pipeline is reworked to resolve message/invitation participants
 * back to a connection, the only reliable join available is the person's
 * display name, which is what this module uses.
 *
 * TODO(Phase 4/6): fix the ingestion-side identityKey derivation for
 * Invitations.csv and messages.csv so this can join on identityKey instead of
 * on a normalized display name.
 */
export type InteractionSignal = {
  /** Messages this person sent to the account owner. */
  inboundMessages: number;
  /** Messages the account owner sent to this person. */
  outboundMessages: number;
  /** Most recent message in either direction, if any. */
  lastMessageAt: Date | null;
  /** An invitation record exists for this person. */
  hasInvitation: boolean;
  /** The invitation carried a personal note (a stronger relationship signal). */
  hasInvitationNote: boolean;
};

export type InteractionSignalMap = {
  /** Keyed by `normalizePersonName(...)`. */
  byName: Map<string, InteractionSignal>;
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
  lastMessageAt: null,
  hasInvitation: false,
  hasInvitationNote: false,
};

/** Lowercases and collapses whitespace so `"  Jane   Doe "` === `"jane doe"`. */
export function normalizePersonName(
  first?: string | null,
  last?: string | null,
): string {
  return [first ?? "", last ?? ""].join(" ").trim().replace(/\s+/g, " ").toLowerCase();
}

export function getSignal(
  signals: InteractionSignalMap,
  name: string,
): InteractionSignal {
  return signals.byName.get(name) ?? EMPTY_SIGNAL;
}

export function blankSignal(): InteractionSignal {
  return { ...EMPTY_SIGNAL };
}
