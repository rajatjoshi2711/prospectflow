import type { CampaignLeadStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { loadInteractionSignals } from "@/lib/insights/load-signals";
import { toPersonRef } from "@/lib/insights/signals";
import { deriveLeadStatus } from "@/lib/insights/status";

/**
 * Links campaign leads to the user's own network.
 *
 * Loads every `Connection` from the user's most recent COMPLETE import (the
 * same "current snapshot" definition the dashboards use) and indexes it by the
 * two keys ingestion writes:
 *
 *   `identityKey` — `url:<normalized profile url>`. EXACT. Connections.csv
 *                   carries a profile URL for essentially every row, and a
 *                   campaign lead only reaches here when the confirmed column
 *                   held one too, so where the person really is in the user's
 *                   network this matches — expect the large majority of hits.
 *   `nameKey`     — `name:<normalized display name>`. Weak, and only consulted
 *                   when the URL key missed. Two different people with the same
 *                   display name share a nameKey (see identity-key.ts), so this
 *                   can mis-attribute. It only ever adds a relationship-strength
 *                   read and a "in your network" note — never an irreversible
 *                   action — which is why the fallback is worth keeping.
 *
 * A lead that matches nothing keeps `connectionId = null`, and the UI shows it
 * as not in the network / not yet scored rather than inventing a score.
 */
export async function buildConnectionIndex(userId: string) {
  const batch = await prisma.importBatch.findFirst({
    where: { userId, status: "COMPLETE" },
    orderBy: { completedAt: "desc" },
    select: { id: true },
  });
  if (!batch) {
    return {
      batchId: null as string | null,
      byIdentity: new Map<string, string>(),
      byName: new Map<string, string>(),
      byConnectionId: new Map<string, { identityKey: string; nameKey: string | null }>(),
    };
  }

  const connections = await prisma.connection.findMany({
    where: { importBatchId: batch.id },
    select: { id: true, identityKey: true, nameKey: true },
  });

  const byIdentity = new Map<string, string>();
  const byName = new Map<string, string>();
  const byConnectionId = new Map<string, { identityKey: string; nameKey: string | null }>();
  for (const connection of connections) {
    // First writer wins on both maps, so a duplicated export row cannot flip
    // which connection a lead resolves to between runs.
    if (!byIdentity.has(connection.identityKey)) {
      byIdentity.set(connection.identityKey, connection.id);
    }
    if (connection.nameKey && !byName.has(connection.nameKey)) {
      byName.set(connection.nameKey, connection.id);
    }
    byConnectionId.set(connection.id, {
      identityKey: connection.identityKey,
      nameKey: connection.nameKey,
    });
  }
  return { batchId: batch.id, byIdentity, byName, byConnectionId };
}

/** Resolves one lead's keys against the index. */
export function resolveConnectionId(
  index: { byIdentity: Map<string, string>; byName: Map<string, string> },
  identityKey: string | null,
  nameKey: string | null,
): string | null {
  const byIdentity = identityKey ? index.byIdentity.get(identityKey) : undefined;
  if (byIdentity) return byIdentity;
  return (nameKey ? index.byName.get(nameKey) : undefined) ?? null;
}

/**
 * Re-points every one of a user's campaign leads at their CURRENT snapshot.
 *
 * WHY THIS EXISTS
 * ---------------
 * `CampaignLead.connectionId` is a cache of "which person in my network is
 * this lead", resolved once when the campaign was built. That answer expires:
 * each import replaces the current snapshot with a new batch whose rows have
 * new ids, and a lead who was a stranger last month may be a connection now.
 * Without this, a campaign's statuses and relationship bars silently reflect
 * whatever the network looked like on the day the spreadsheet was uploaded.
 *
 * It is also the repair path for campaigns built while ingestion was writing
 * null profile URLs: their leads resolved to nothing through no fault of the
 * lead data, and a re-link against a correctly-parsed import fixes them
 * without the user re-uploading the spreadsheet.
 *
 * It also refreshes `status` for leads the user has never set by hand.
 *
 * WHY STATUS IS STORED RATHER THAN DERIVED AT RENDER TIME
 * ------------------------------------------------------
 * Status used to be computed per rendered row. That cannot work, because the
 * status filter chips count with a SQL `groupBy` and the filter itself is a
 * `WHERE` clause — both read the column. A derived value the column does not
 * know about means the chips say "Connection request pending 100" while the
 * rows on screen say otherwise, and filtering to "Connection accepted" returns
 * nothing. Materializing it here keeps counting, filtering and sorting honest,
 * because they all read the same column the user sees.
 *
 * A hand-set status (`statusSetAt` non-null) is the user's own record of their
 * outreach and is never overwritten.
 */
export async function relinkUserCampaignLeads(userId: string): Promise<{
  examined: number;
  relinked: number;
  restatused: number;
}> {
  const leads = await prisma.campaignLead.findMany({
    where: { campaign: { userId } },
    select: {
      id: true,
      identityKey: true,
      nameKey: true,
      connectionId: true,
      status: true,
      statusSetAt: true,
    },
  });
  if (leads.length === 0) return { examined: 0, relinked: 0, restatused: 0 };

  const index = await buildConnectionIndex(userId);
  // No current snapshot means no basis to re-link against. Leave the existing
  // links alone rather than clearing them on the strength of no evidence.
  if (!index.batchId) return { examined: leads.length, relinked: 0, restatused: 0 };

  const resolvedFor = new Map<string, string | null>();
  for (const lead of leads) {
    resolvedFor.set(lead.id, resolveConnectionId(index, lead.identityKey, lead.nameKey));
  }

  // Signals are per batch and keyed by the connection's identity, so load them
  // once for every connection any lead resolved to.
  const people = [...new Set([...resolvedFor.values()].filter((id): id is string => id !== null))]
    .map((id) => index.byConnectionId.get(id))
    .filter((ref): ref is { identityKey: string; nameKey: string | null } => Boolean(ref))
    .map((ref) => toPersonRef(ref));
  const signals = await loadInteractionSignals(index.batchId, people);

  let relinked = 0;
  let restatused = 0;
  for (const lead of leads) {
    const connectionId = resolvedFor.get(lead.id) ?? null;
    const identityKey = connectionId
      ? (index.byConnectionId.get(connectionId)?.identityKey ?? "")
      : "";

    const data: { connectionId?: string | null; status?: CampaignLeadStatus } = {};
    if (connectionId !== lead.connectionId) data.connectionId = connectionId;

    if (!lead.statusSetAt) {
      const derived = deriveLeadStatus({
        isConnected: connectionId !== null,
        signals,
        identityKey,
      });
      if (derived !== lead.status) data.status = derived;
    }

    if (Object.keys(data).length === 0) continue;
    await prisma.campaignLead.update({ where: { id: lead.id }, data });
    if (data.connectionId !== undefined) relinked += 1;
    if (data.status !== undefined) restatused += 1;
  }
  return { examined: leads.length, relinked, restatused };
}
