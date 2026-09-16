import "server-only";

import { prisma } from "@/lib/prisma";
import { loadInteractionSignals } from "@/lib/insights/load-signals";
import { loadStoredRelationshipScores } from "@/lib/insights/load-stored-scores";
import { loadConnectionMarks } from "@/lib/insights/marks";
import { toPersonRef } from "@/lib/insights/signals";
import {
  deriveRelationshipStrength,
  resolveRelationshipStrength,
  type RelationshipStrength,
} from "@/lib/insights/relationship";
import { deriveLeadStatus } from "@/lib/insights/status";
import type { CampaignLeadStatus, ConnectionMarkValue } from "@prisma/client";

/**
 * Everything the prospect detail page renders, for ONE person, scoped to ONE
 * organization.
 *
 * SCOPING — the load-bearing part
 * -------------------------------
 * Every query below starts from `organizationId`, taken from the signed-in
 * session and never from the URL. The org's member ids are resolved first and
 * every subsequent read is filtered to import batches owned by those members,
 * so there is no query on this page that could reach another organization's
 * data even if the `identityKey` in the URL happens to name a person two
 * different companies both know. `identityKey` is a global person key, not a
 * tenant-scoped id, which is exactly why the tenant filter has to be explicit
 * on every read rather than implied by the key.
 */

/** How many messages are rendered. The rest are counted, not sent to the page. */
export const MESSAGE_RENDER_LIMIT = 50;

export type ProspectMessage = {
  id: string;
  sentAt: Date | null;
  /**
   * `sent` = the account owner wrote it, `received` = the prospect did,
   * `unknown` = the export did not let ingestion tell (see
   * `MessageRecord.senderIsUser`). `unknown` is a real state and is labelled as
   * one — guessing a direction would put words in someone's mouth.
   */
  direction: "sent" | "received" | "unknown";
  body: string | null;
};

export type ProspectMessages =
  | { kind: "no-message-data" }
  | { kind: "not-in-your-snapshot" }
  | { kind: "none" }
  | { kind: "some"; messages: ProspectMessage[]; total: number; shown: number };

export type OrgCoverageEntry = {
  userId: string;
  name: string;
  isViewer: boolean;
  /** null = that member's snapshot has them but no scoring run has reached them. */
  score: number | null;
  basis: "ai" | "heuristic" | null;
};

export type ProspectNoteView = {
  id: string;
  body: string;
  createdAt: Date;
  authorId: string;
  authorName: string;
  /** True when the signed-in user is allowed to delete it. Mirrors, never replaces, the server check. */
  canDelete: boolean;
};

/**
 * One saved research run, ready to render.
 *
 * Org-visible and attributed like a note: the reader needs to know who paid for
 * it and when, because "recent news" ages.
 */
export type ProspectResearchView = {
  id: string;
  summary: string;
  /** Validated http(s) URLs. Empty means the run produced none — never a guess. */
  citations: string[];
  model: string;
  createdAt: Date;
  requestedByName: string;
};

export type ProspectDetail = {
  identityKey: string;
  name: string;
  position: string | null;
  company: string | null;
  linkedinUrl: string | null;
  connectedOn: Date | null;
  /** False when the person is in a colleague's snapshot but not the viewer's own. */
  inViewerSnapshot: boolean;
  /** The date of the snapshot these details came from. */
  snapshotDate: Date | null;
  /** Whose snapshot the displayed details came from, when it is not the viewer's. */
  detailsFromMemberName: string | null;
  /**
   * The campaign whose lead list the displayed details came from, when nobody
   * in the org has this person in an import at all. Non-null means every field
   * in the header came from an uploaded spreadsheet rather than from LinkedIn,
   * and the page says so — presenting sheet data as export data would be a
   * quiet lie about where a job title came from.
   */
  detailsFromCampaignName: string | null;
  status: CampaignLeadStatus | null;
  strength: RelationshipStrength | null;
  mark: ConnectionMarkValue | null;
  messages: ProspectMessages;
  coverage: OrgCoverageEntry[];
  organizationName: string;
  notes: ProspectNoteView[];
  /** Saved research runs for this person in this org, newest first. */
  research: ProspectResearchView[];
};

/**
 * Returns null when the person is not visible to this viewer at all — the page
 * turns that into a 404. Two things make a person visible (see
 * `identityKeyIsVisible`, which is the same rule the write routes enforce):
 *
 *   1. They appear in a completed import owned by ANY member of the org.
 *      Checked against EVERY completed batch, not just current snapshots, for
 *      the same reason `/api/connections/marks` does: someone who dropped out
 *      of the most recent export is still a person this org legitimately knows,
 *      and a link to them should not rot.
 *   2. They are a lead in one of the VIEWER'S OWN campaigns. A cold lead who
 *      matched nobody in anyone's network still deserves a page to hang notes,
 *      research and a usefulness mark on.
 *
 * Rule 2 is deliberately the viewer's campaigns and not the org's. Campaigns
 * are per-user throughout this codebase (`Campaign.userId`, and see the
 * campaigns page), unlike ICPs, notes and research, which are org assets. If a
 * colleague's private lead list could conjure a page, one member's spreadsheet
 * would become a way for everyone else to address people the org has never met.
 * Everything ON the page stays org-scoped exactly as before.
 */
export async function loadProspectDetail({
  identityKey,
  viewerId,
  viewerRole,
  organizationId,
}: {
  identityKey: string;
  viewerId: string;
  viewerRole: "ADMIN" | "MEMBER";
  organizationId: string;
}): Promise<ProspectDetail | null> {
  const [organization, members] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    }),
    prisma.user.findMany({
      where: { organizationId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  if (!organization) return null;

  const memberIds = members.map((member) => member.id);
  const memberName = new Map(members.map((member) => [member.id, member.name]));

  // Every completed batch in the org, newest first. Bounded by members ×
  // imports-per-member, which is a handful of rows per person — imports are a
  // deliberate, occasional action, not a stream. Picking the latest per member
  // in JS avoids a correlated subquery for what is a very small list.
  const batches = await prisma.importBatch.findMany({
    where: { userId: { in: memberIds }, status: "COMPLETE" },
    select: { id: true, userId: true, completedAt: true, createdAt: true },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
  });

  const latestBatchByUser = new Map<string, (typeof batches)[number]>();
  for (const batch of batches) {
    if (!latestBatchByUser.has(batch.userId)) latestBatchByUser.set(batch.userId, batch);
  }
  const batchById = new Map(batches.map((batch) => [batch.id, batch]));

  // One query for the whole org's view of this person, across every completed
  // batch. `Connection.identityKey` is indexed and this is one person, so the
  // result is small.
  // Skipped entirely when the org has no completed import yet — there is
  // nothing for the `in` list to match, and a campaign-only person still has a
  // page below.
  const connections = batches.length === 0 ? [] : await prisma.connection.findMany({
    where: { identityKey, importBatchId: { in: batches.map((batch) => batch.id) } },
    select: {
      id: true,
      importBatchId: true,
      identityKey: true,
      nameKey: true,
      firstName: true,
      lastName: true,
      company: true,
      position: true,
      linkedinUrl: true,
      connectedOn: true,
      relationshipScore: true,
      relationshipBasis: true,
    },
  });
  if (connections.length === 0) {
    return loadCampaignOnlyDetail({
      identityKey,
      viewerId,
      viewerRole,
      organizationId,
      organizationName: organization.name,
      memberName,
    });
  }

  const viewerBatch = latestBatchByUser.get(viewerId) ?? null;
  const viewerConnection =
    (viewerBatch && connections.find((row) => row.importBatchId === viewerBatch.id)) || null;

  // Display details come from the viewer's own snapshot when they have one, and
  // otherwise from the most recently completed snapshot in the org that does.
  // The page says which, rather than presenting a colleague's data as the
  // viewer's own.
  const detailSource =
    viewerConnection ??
    connections
      .slice()
      .sort((a, b) => {
        const left = batchById.get(a.importBatchId);
        const right = batchById.get(b.importBatchId);
        return (
          (right?.completedAt ?? right?.createdAt ?? new Date(0)).getTime() -
          (left?.completedAt ?? left?.createdAt ?? new Date(0)).getTime()
        );
      })[0];

  const detailBatch = batchById.get(detailSource.importBatchId) ?? null;
  const name =
    [detailSource.firstName, detailSource.lastName].filter(Boolean).join(" ").trim() ||
    "Unnamed connection";

  const [messages, notes, research, mark] = await Promise.all([
    loadMessages({ viewerBatchId: viewerBatch?.id ?? null, connection: viewerConnection }),
    loadNotes({ organizationId, identityKey, viewerId, viewerRole, memberName }),
    loadResearch({ organizationId, identityKey, memberName }),
    // Marks are private to the viewer, so this reads only their own row.
    loadConnectionMarks(viewerId, [identityKey]).then((map) => map.get(identityKey) ?? null),
  ]);

  const strength = viewerConnection
    ? await resolveViewerStrength({
        viewerId,
        viewerBatchId: viewerBatch!.id,
        connection: viewerConnection,
      })
    : null;

  const status = viewerConnection
    ? await deriveViewerStatus({ viewerBatchId: viewerBatch!.id, connection: viewerConnection })
    : null;

  return {
    identityKey,
    name,
    position: detailSource.position,
    company: detailSource.company,
    linkedinUrl: detailSource.linkedinUrl,
    connectedOn: detailSource.connectedOn,
    inViewerSnapshot: viewerConnection !== null,
    snapshotDate: detailBatch?.completedAt ?? detailBatch?.createdAt ?? null,
    detailsFromMemberName: viewerConnection
      ? null
      : (memberName.get(detailBatch?.userId ?? "") ?? null),
    detailsFromCampaignName: null,
    status,
    strength,
    mark,
    messages,
    coverage: buildCoverage({
      connections,
      batchById,
      latestBatchByUser,
      memberName,
      viewerId,
    }),
    organizationName: organization.name,
    notes,
    research,
  };
}

/**
 * The page for a person nobody in the org has imported, built from the VIEWER'S
 * OWN campaign lead row.
 *
 * Every field here comes from an uploaded spreadsheet, so the result says so
 * (`detailsFromCampaignName`) and leaves `snapshotDate` / `connectedOn` null —
 * there is no import behind these details and dating them would invent one.
 *
 * The org-scoped parts of the page (notes, research) are loaded exactly as they
 * are for a connection: they are keyed by (organizationId, identityKey) and
 * never needed a `Connection` row to exist. Coverage is empty by construction —
 * we only get here when no member has them — and that emptiness is itself the
 * useful answer for a cold lead, which the page words accordingly.
 *
 * Returns null when the viewer has no such lead, which is the 404.
 */
async function loadCampaignOnlyDetail({
  identityKey,
  viewerId,
  viewerRole,
  organizationId,
  organizationName,
  memberName,
}: {
  identityKey: string;
  viewerId: string;
  viewerRole: "ADMIN" | "MEMBER";
  organizationId: string;
  organizationName: string;
  memberName: Map<string, string>;
}): Promise<ProspectDetail | null> {
  // Scoped through the campaign's owner, never through the org: campaigns are
  // personal, so a colleague's lead list must not make this page exist.
  const lead = await prisma.campaignLead.findFirst({
    where: { identityKey, campaign: { userId: viewerId } },
    // Newest first: if the same person sits in two of the viewer's lead lists,
    // the most recently uploaded sheet is the more current description of them.
    orderBy: { createdAt: "desc" },
    select: {
      firstName: true,
      lastName: true,
      company: true,
      position: true,
      linkedinUrl: true,
      status: true,
      statusSetAt: true,
      campaign: { select: { name: true } },
    },
  });
  if (!lead) return null;

  const [notes, research, mark] = await Promise.all([
    loadNotes({ organizationId, identityKey, viewerId, viewerRole, memberName }),
    loadResearch({ organizationId, identityKey, memberName }),
    loadConnectionMarks(viewerId, [identityKey]).then((map) => map.get(identityKey) ?? null),
  ]);

  return {
    identityKey,
    name: [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() || "Unnamed lead",
    position: lead.position,
    company: lead.company,
    linkedinUrl: lead.linkedinUrl,
    connectedOn: null,
    inViewerSnapshot: false,
    snapshotDate: null,
    detailsFromMemberName: null,
    detailsFromCampaignName: lead.campaign.name,
    // Only a status the user SET BY HAND is shown. `status` otherwise holds its
    // creation default (`statusSetAt` is null), which for a lead with no
    // connection and no messages behind it carries no information — the "Not in
    // your network" state is the honest reading. Same distinction the schema
    // comment on `statusSetAt` draws.
    status: lead.statusSetAt ? lead.status : null,
    strength: null,
    mark,
    messages: { kind: "not-in-your-snapshot" },
    coverage: [],
    organizationName,
    notes,
    research,
  };
}

/**
 * Org coverage: which members have this person in THEIR current snapshot.
 *
 * Only the latest COMPLETE batch per member counts — that is the snapshot every
 * other surface in the app reads, so a colleague whose older export mentioned
 * this person but whose current one does not is correctly absent.
 *
 * The score shown is each member's MATERIALIZED `Connection.relationshipScore`.
 * Falling back to the read-time heuristic here would mean loading every other
 * member's whole interaction signal set, one query per member, for a sidebar
 * list. A null column renders as "Not yet scored" — never as a zero, which
 * would read as "a weak relationship" rather than "no data".
 */
function buildCoverage({
  connections,
  batchById,
  latestBatchByUser,
  memberName,
  viewerId,
}: {
  connections: {
    importBatchId: string;
    relationshipScore: number | null;
    relationshipBasis: string | null;
  }[];
  batchById: Map<string, { id: string; userId: string }>;
  latestBatchByUser: Map<string, { id: string }>;
  memberName: Map<string, string>;
  viewerId: string;
}): OrgCoverageEntry[] {
  const entries: OrgCoverageEntry[] = [];

  for (const connection of connections) {
    const batch = batchById.get(connection.importBatchId);
    if (!batch) continue;
    if (latestBatchByUser.get(batch.userId)?.id !== batch.id) continue;

    entries.push({
      userId: batch.userId,
      name: memberName.get(batch.userId) ?? "A colleague",
      isViewer: batch.userId === viewerId,
      score: connection.relationshipScore,
      basis:
        connection.relationshipScore === null
          ? null
          : connection.relationshipBasis === "ai"
            ? "ai"
            : "heuristic",
    });
  }

  // Viewer first, then strongest relationship first so "who should approach
  // them" is answerable by reading the top of the list.
  return entries.sort((a, b) => {
    if (a.isViewer !== b.isViewer) return a.isViewer ? -1 : 1;
    return (b.score ?? -1) - (a.score ?? -1);
  });
}

/**
 * The conversation with this person, from the viewer's OWN current snapshot.
 *
 * Messages are keyed to the counterparty at ingestion time, so this is the same
 * join `loadInteractionSignals` uses: `identityKey` first, `nameKey` as the
 * fallback for exports that only name the other party. The name fallback is
 * inexact (two people with one display name share a `nameKey`) — see
 * `src/lib/insights/signals.ts`.
 *
 * BOUNDED: a long-running thread can hold thousands of rows, so the query takes
 * the most recent `MESSAGE_RENDER_LIMIT` and reports the total separately. The
 * rendered slice is then flipped back into chronological order for reading.
 */
async function loadMessages({
  viewerBatchId,
  connection,
}: {
  viewerBatchId: string | null;
  connection: { identityKey: string; nameKey: string | null; firstName: string | null; lastName: string | null } | null;
}): Promise<ProspectMessages> {
  if (!viewerBatchId || !connection) return { kind: "not-in-your-snapshot" };

  const batchMessageCount = await prisma.messageRecord.count({
    where: { importBatchId: viewerBatchId },
  });
  if (batchMessageCount === 0) return { kind: "no-message-data" };

  const ref = toPersonRef(connection);
  const match = {
    OR: [
      { identityKey: ref.identityKey },
      ...(ref.nameKey ? [{ nameKey: ref.nameKey }] : []),
    ],
  };
  const where = { importBatchId: viewerBatchId, ...match };

  const total = await prisma.messageRecord.count({ where });
  if (total === 0) return { kind: "none" };

  const rows = await prisma.messageRecord.findMany({
    where,
    // Newest first so the cap keeps the RECENT end of a long thread, which is
    // the part anyone opening this page is looking for.
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
    take: MESSAGE_RENDER_LIMIT,
    select: { id: true, sentAt: true, senderIsUser: true, content: true },
  });

  const messages: ProspectMessage[] = rows
    .slice()
    .reverse()
    .map((row) => ({
      id: row.id,
      sentAt: row.sentAt,
      direction:
        row.senderIsUser === true ? "sent" : row.senderIsUser === false ? "received" : "unknown",
      body: row.content,
    }));

  return { kind: "some", messages, total, shown: messages.length };
}

/** The viewer's own relationship strength, resolved exactly as the tables do. */
async function resolveViewerStrength({
  viewerId,
  viewerBatchId,
  connection,
}: {
  viewerId: string;
  viewerBatchId: string;
  connection: {
    id: string;
    identityKey: string;
    nameKey: string | null;
    firstName: string | null;
    lastName: string | null;
    connectedOn: Date | null;
    relationshipScore: number | null;
    relationshipBasis: string | null;
  };
}): Promise<RelationshipStrength | null> {
  const [signals, storedScores] = await Promise.all([
    loadInteractionSignals(viewerBatchId, [toPersonRef(connection)]),
    loadStoredRelationshipScores(viewerId, [connection.id]),
  ]);

  return resolveRelationshipStrength({
    materialized: {
      score: connection.relationshipScore,
      basis: connection.relationshipBasis,
    },
    derived: deriveRelationshipStrength({
      signals,
      identityKey: connection.identityKey,
      connectedOn: connection.connectedOn,
      stored: storedScores.get(connection.id) ?? null,
    }),
  });
}

async function deriveViewerStatus({
  viewerBatchId,
  connection,
}: {
  viewerBatchId: string;
  connection: { identityKey: string; nameKey: string | null; firstName: string | null; lastName: string | null };
}): Promise<CampaignLeadStatus> {
  const signals = await loadInteractionSignals(viewerBatchId, [toPersonRef(connection)]);
  // `isConnected: true` — this row came out of the viewer's own Connections.csv.
  // No `storedStatus`: a campaign lead's status belongs to that campaign, and
  // letting it rewrite the network-wide view is the thing `deriveLeadStatus`
  // documents as deliberately not done.
  return deriveLeadStatus({ isConnected: true, signals, identityKey: connection.identityKey });
}

async function loadNotes({
  organizationId,
  identityKey,
  viewerId,
  viewerRole,
  memberName,
}: {
  organizationId: string;
  identityKey: string;
  viewerId: string;
  viewerRole: "ADMIN" | "MEMBER";
  memberName: Map<string, string>;
}): Promise<ProspectNoteView[]> {
  const notes = await prisma.prospectNote.findMany({
    // The org filter is the tenant boundary: notes are keyed by
    // (organizationId, identityKey), so without it the same global person key
    // would surface another company's notes.
    where: { organizationId, identityKey },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      body: true,
      createdAt: true,
      authorId: true,
      author: { select: { name: true } },
    },
  });

  return notes.map((note) => ({
    id: note.id,
    body: note.body,
    createdAt: note.createdAt,
    authorId: note.authorId,
    authorName: note.author.name ?? memberName.get(note.authorId) ?? "A colleague",
    // Presentation only. The same rule is enforced in the DELETE route's WHERE
    // clause, which is what actually protects the row.
    canDelete: note.authorId === viewerId || viewerRole === "ADMIN",
  }));
}

/**
 * Saved research runs for this person, for this org.
 *
 * Same tenant boundary as notes: `ProspectResearch` is keyed by
 * (organizationId, identityKey), and `identityKey` is a GLOBAL person key, so
 * the org filter is the only thing stopping one company's paid-for research
 * from surfacing in another's. Capped — the box shows the latest run and lists
 * the rest, and nobody reads a hundred of them.
 */
async function loadResearch({
  organizationId,
  identityKey,
  memberName,
}: {
  organizationId: string;
  identityKey: string;
  memberName: Map<string, string>;
}): Promise<ProspectResearchView[]> {
  const rows = await prisma.prospectResearch.findMany({
    where: { organizationId, identityKey },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      summary: true,
      citations: true,
      model: true,
      createdAt: true,
      requestedById: true,
      requestedBy: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    summary: row.summary,
    citations: row.citations,
    model: row.model,
    createdAt: row.createdAt,
    requestedByName: row.requestedBy.name ?? memberName.get(row.requestedById) ?? "A colleague",
  }));
}

/**
 * Is this person someone the signed-in viewer can legitimately address?
 *
 * The keys on `ProspectNote`, `ProspectResearch` and `ConnectionMark` are
 * deliberately not foreign keys (the person outlives any `Connection` row), so
 * nothing in the database stops a hand-crafted request from writing against an
 * arbitrary string. This is the gate that does, and it is the SAME rule
 * `loadProspectDetail` uses to decide whether the page exists at all — if a
 * viewer can open the page, they can write a note or run research on it, and if
 * they cannot, every write route says 404 too.
 *
 * True when EITHER:
 *   - any member of the org has them in a completed import, or
 *   - the viewer has them as a lead in one of their OWN campaigns.
 *
 * The second arm is the viewer's campaigns rather than the org's on purpose:
 * campaigns are per-user, and a colleague's private lead list should not become
 * a way to address people the org has never met. Note that the ASSET being
 * written stays org-scoped (a note is shared) or user-scoped (a mark is
 * private) exactly as before — this only decides who may be written about.
 */
export async function identityKeyIsVisible({
  organizationId,
  viewerId,
  identityKey,
}: {
  organizationId: string;
  viewerId: string;
  identityKey: string;
}): Promise<boolean> {
  const [connection, lead] = await Promise.all([
    prisma.connection.findFirst({
      where: {
        identityKey,
        importBatch: { status: "COMPLETE", user: { organizationId } },
      },
      select: { id: true },
    }),
    prisma.campaignLead.findFirst({
      where: { identityKey, campaign: { userId: viewerId } },
      select: { id: true },
    }),
  ]);
  return connection !== null || lead !== null;
}
