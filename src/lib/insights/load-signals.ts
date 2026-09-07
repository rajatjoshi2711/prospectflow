import "server-only";

import { prisma } from "@/lib/prisma";
import {
  blankSignal,
  type InteractionSignal,
  type InteractionSignalMap,
} from "@/lib/insights/signals";

/**
 * Loads message + invitation signals for a bounded set of people inside one
 * import batch. Always call this with the page of rows actually being
 * rendered (tens of names), never with the whole connection list.
 */
export async function loadInteractionSignals(
  importBatchId: string,
  names: string[],
): Promise<InteractionSignalMap> {
  const wanted = new Set(names.filter((n) => n.length > 0));

  const [messageCount, invitationCount] = await Promise.all([
    prisma.messageRecord.count({ where: { importBatchId } }),
    prisma.invitation.count({ where: { importBatchId } }),
  ]);
  const hasAnyInteractionData = messageCount > 0 || invitationCount > 0;

  const byName = new Map<string, InteractionSignal>();
  if (wanted.size === 0 || !hasAnyInteractionData) {
    return { byName, hasAnyInteractionData };
  }

  const nameFilters = [...wanted];
  const [messages, invitations] = await Promise.all([
    messageCount > 0
      ? prisma.messageRecord.findMany({
          where: {
            importBatchId,
            OR: [
              { from: { in: nameFilters, mode: "insensitive" } },
              { to: { in: nameFilters, mode: "insensitive" } },
            ],
          },
          select: { from: true, to: true, sentAt: true },
        })
      : Promise.resolve([]),
    invitationCount > 0
      ? prisma.invitation.findMany({
          where: {
            importBatchId,
            OR: [
              { from: { in: nameFilters, mode: "insensitive" } },
              { to: { in: nameFilters, mode: "insensitive" } },
            ],
          },
          select: { from: true, to: true, message: true },
        })
      : Promise.resolve([]),
  ]);

  const norm = (value: string | null) =>
    (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

  for (const message of messages) {
    const from = norm(message.from);
    const to = norm(message.to);

    if (wanted.has(from)) {
      const signal = byName.get(from) ?? blankSignal();
      signal.inboundMessages += 1;
      if (message.sentAt && (!signal.lastMessageAt || message.sentAt > signal.lastMessageAt)) {
        signal.lastMessageAt = message.sentAt;
      }
      byName.set(from, signal);
    }
    if (wanted.has(to)) {
      const signal = byName.get(to) ?? blankSignal();
      signal.outboundMessages += 1;
      if (message.sentAt && (!signal.lastMessageAt || message.sentAt > signal.lastMessageAt)) {
        signal.lastMessageAt = message.sentAt;
      }
      byName.set(to, signal);
    }
  }

  for (const invitation of invitations) {
    for (const candidate of [norm(invitation.from), norm(invitation.to)]) {
      if (!wanted.has(candidate)) continue;
      const signal = byName.get(candidate) ?? blankSignal();
      signal.hasInvitation = true;
      if ((invitation.message ?? "").trim().length > 0) {
        signal.hasInvitationNote = true;
      }
      byName.set(candidate, signal);
    }
  }

  return { byName, hasAnyInteractionData };
}
