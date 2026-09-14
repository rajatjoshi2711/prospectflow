import { prisma } from "@/lib/prisma";

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
    return { byIdentity: new Map<string, string>(), byName: new Map<string, string>() };
  }

  const connections = await prisma.connection.findMany({
    where: { importBatchId: batch.id },
    select: { id: true, identityKey: true, nameKey: true },
  });

  const byIdentity = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const connection of connections) {
    // First writer wins on both maps, so a duplicated export row cannot flip
    // which connection a lead resolves to between runs.
    if (!byIdentity.has(connection.identityKey)) {
      byIdentity.set(connection.identityKey, connection.id);
    }
    if (connection.nameKey && !byName.has(connection.nameKey)) {
      byName.set(connection.nameKey, connection.id);
    }
  }
  return { byIdentity, byName };
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
 * Only `connectionId` is touched. A manually-set `CampaignLead.status` is the
 * user's own record of their outreach and is never overwritten here.
 */
export async function relinkUserCampaignLeads(userId: string): Promise<{
  examined: number;
  changed: number;
}> {
  const leads = await prisma.campaignLead.findMany({
    where: { campaign: { userId } },
    select: { id: true, identityKey: true, nameKey: true, connectionId: true },
  });
  if (leads.length === 0) return { examined: 0, changed: 0 };

  const index = await buildConnectionIndex(userId);
  // No current snapshot means no basis to re-link against. Leave the existing
  // links alone rather than clearing them on the strength of no evidence.
  if (index.byIdentity.size === 0 && index.byName.size === 0) {
    return { examined: leads.length, changed: 0 };
  }

  let changed = 0;
  for (const lead of leads) {
    const resolved = resolveConnectionId(index, lead.identityKey, lead.nameKey);
    if (resolved === lead.connectionId) continue;
    await prisma.campaignLead.update({
      where: { id: lead.id },
      data: { connectionId: resolved },
    });
    changed += 1;
  }
  return { examined: leads.length, changed };
}
