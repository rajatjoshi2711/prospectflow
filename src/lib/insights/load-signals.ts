import "server-only";

import { prisma } from "@/lib/prisma";
import {
  blankSignal,
  type InteractionSignal,
  type InteractionSignalMap,
  type PersonRef,
} from "@/lib/insights/signals";

/**
 * Loads message + invitation signals for a bounded set of people inside one
 * import batch. Always call this with the page of rows actually being
 * rendered (tens of people), never with the whole connection list.
 *
 * Messages and invitations are keyed to the counterparty at ingestion time, so
 * this joins on the counterparty keys directly: `identityKey` (exact, URL
 * based) with a `nameKey` fallback for the very common case where the export
 * only names the counterparty. See `signals.ts` for the collision caveat on
 * the name fallback.
 *
 * LEGACY ROWS: batches imported before this fix have `nameKey = null` and a
 * counterparty-less `identityKey` (messages were keyed off the `From` name,
 * whoever that was). Those rows simply fail to match and contribute no
 * signals — they are never mis-attributed. Re-uploading the export re-keys
 * them correctly.
 */
export async function loadInteractionSignals(
  importBatchId: string,
  people: PersonRef[],
): Promise<InteractionSignalMap> {
  const byKey = new Map<string, InteractionSignal>();

  const [messageCount, invitationCount] = await Promise.all([
    prisma.messageRecord.count({ where: { importBatchId } }),
    prisma.invitation.count({ where: { importBatchId } }),
  ]);
  const hasAnyInteractionData = messageCount > 0 || invitationCount > 0;

  if (people.length === 0 || !hasAnyInteractionData) {
    return { byKey, hasAnyInteractionData };
  }

  // identityKey / nameKey -> the connection identityKey to attribute to.
  const byIdentity = new Map<string, string>();
  const byNameKey = new Map<string, string>();
  for (const person of people) {
    byIdentity.set(person.identityKey, person.identityKey);
    // First writer wins: if two connections on this page share a display name
    // we cannot tell their name-keyed rows apart, so we attribute them to one
    // rather than double-counting them onto both.
    if (person.nameKey && !byNameKey.has(person.nameKey)) {
      byNameKey.set(person.nameKey, person.identityKey);
    }
  }

  const identityKeys = [...byIdentity.keys()];
  const nameKeys = [...byNameKey.keys()];
  const match = { OR: [{ identityKey: { in: identityKeys } }, { nameKey: { in: nameKeys } }] };

  const [messages, invitations] = await Promise.all([
    messageCount > 0
      ? prisma.messageRecord.findMany({
          where: { importBatchId, ...match },
          select: { identityKey: true, nameKey: true, senderIsUser: true, sentAt: true },
        })
      : Promise.resolve([]),
    invitationCount > 0
      ? prisma.invitation.findMany({
          where: { importBatchId, ...match },
          select: { identityKey: true, nameKey: true, message: true },
        })
      : Promise.resolve([]),
  ]);

  const resolve = (row: { identityKey: string; nameKey: string | null }) =>
    byIdentity.get(row.identityKey) ?? (row.nameKey ? byNameKey.get(row.nameKey) : undefined);

  for (const message of messages) {
    const owner = resolve(message);
    if (!owner) continue;
    const signal = byKey.get(owner) ?? blankSignal();

    if (message.senderIsUser === true) {
      signal.outboundMessages += 1;
    } else if (message.senderIsUser === false) {
      signal.inboundMessages += 1;
    } else {
      // Direction unknown: still evidence of a conversation, but it must not
      // be counted as a reply.
      signal.undirectedMessages += 1;
    }

    if (message.sentAt && (!signal.lastMessageAt || message.sentAt > signal.lastMessageAt)) {
      signal.lastMessageAt = message.sentAt;
    }
    byKey.set(owner, signal);
  }

  for (const invitation of invitations) {
    const owner = resolve(invitation);
    if (!owner) continue;
    const signal = byKey.get(owner) ?? blankSignal();
    signal.hasInvitation = true;
    if ((invitation.message ?? "").trim().length > 0) {
      signal.hasInvitationNote = true;
    }
    byKey.set(owner, signal);
  }

  return { byKey, hasAnyInteractionData };
}
