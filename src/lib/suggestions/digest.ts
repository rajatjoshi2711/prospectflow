import "server-only";

import { prisma } from "@/lib/prisma";
import { listOrgMembers } from "@/lib/insights/org";

/**
 * Builds the compact, structured digest the quick-suggestions model reasons
 * over.
 *
 * WHY A DIGEST AND NOT ROWS
 * -------------------------
 * "Who should reach out to whom for what" spans every member's whole graph. An
 * org with five members and 20,000 connections between them cannot be handed to
 * a model, and does not need to be: the answer only ever comes from the top of
 * the pile. So this assembles a bounded candidate list — people who already
 * score as an ICP or channel-partner match, ranked by match score and by how
 * strong the holder's relationship with them is — and the model chooses among
 * those. It never sees a raw row, and it can never name a person who was not
 * offered.
 *
 * MULTI-TENANCY: every query below filters on `organizationId`, either directly
 * or through the member list. Connections are reached only via a member's own
 * latest import batch.
 */

export type SuggestionCandidate = {
  connectionId: string;
  /** The org member who holds this relationship. */
  sourceUserId: string;
  sourceUserName: string;
  personName: string;
  company: string | null;
  position: string | null;
  country: string | null;
  matchType: "ICP" | "CHANNEL_PARTNER";
  definitionName: string;
  matchScore: number;
  matchRationale: string | null;
  /** Null when the relationship has not been scored — never rendered as zero. */
  relationshipScore: number | null;
  /** How many OTHER members also have this person in their current snapshot. */
  alsoKnownByCount: number;
  /** Names of up to three of those other members. */
  alsoKnownBy: string[];
};

export type OrgDigest = {
  organizationId: string;
  members: { id: string; name: string; connectionCount: number }[];
  candidates: SuggestionCandidate[];
};

/** Hard cap on candidates considered — and therefore on prompt size. */
const MAX_CANDIDATES = 60;
/** Matches below this are not worth an outreach suggestion. */
const MIN_MATCH_SCORE = 60;
/** Safety cap on match rows pulled per member before ranking. */
const MAX_MATCH_ROWS_PER_MEMBER = 200;

export async function buildOrgDigest(organizationId: string): Promise<OrgDigest> {
  const members = await listOrgMembers(organizationId);
  const withImports = members.filter((member) => member.latestBatchId !== null);

  const digest: OrgDigest = {
    organizationId,
    members: members.map((member) => ({
      id: member.id,
      name: member.name,
      connectionCount: member.connectionCount,
    })),
    candidates: [],
  };

  if (withImports.length === 0) return digest;

  const rows: SuggestionCandidate[] = [];

  for (const member of withImports) {
    const matches = await prisma.prospectMatch.findMany({
      where: {
        score: { gte: MIN_MATCH_SCORE },
        connection: { importBatchId: member.latestBatchId! },
        // Belt and braces: the batch already belongs to this org's member, and
        // the definition must belong to this org too.
        OR: [
          { icp: { organizationId } },
          { channelPartner: { organizationId } },
        ],
      },
      orderBy: { score: "desc" },
      take: MAX_MATCH_ROWS_PER_MEMBER,
      select: {
        score: true,
        rationale: true,
        matchType: true,
        icp: { select: { name: true } },
        channelPartner: { select: { name: true } },
        connection: {
          select: {
            id: true,
            identityKey: true,
            firstName: true,
            lastName: true,
            company: true,
            position: true,
            country: true,
          },
        },
      },
    });
    if (matches.length === 0) continue;

    const scores = await prisma.relationshipStrengthScore.findMany({
      where: {
        userId: member.id,
        connectionId: { in: matches.map((match) => match.connection.id) },
      },
      select: { connectionId: true, score: true },
    });
    const scoreByConnection = new Map(scores.map((row) => [row.connectionId, row.score]));

    for (const match of matches) {
      rows.push({
        connectionId: match.connection.id,
        sourceUserId: member.id,
        sourceUserName: member.name,
        personName:
          [match.connection.firstName, match.connection.lastName]
            .filter(Boolean)
            .join(" ")
            .trim() || "Unknown",
        company: match.connection.company,
        position: match.connection.position,
        country: match.connection.country,
        matchType: match.matchType,
        definitionName: match.icp?.name ?? match.channelPartner?.name ?? "Unknown",
        matchScore: match.score,
        matchRationale: match.rationale,
        relationshipScore: scoreByConnection.get(match.connection.id) ?? null,
        alsoKnownByCount: 0,
        alsoKnownBy: [],
      });
    }
  }

  if (rows.length === 0) return digest;

  // Rank before the (more expensive) overlap pass, so overlap is only computed
  // for candidates that will actually be offered.
  rows.sort(rankCandidates);
  const shortlist = rows.slice(0, MAX_CANDIDATES);

  await annotateOverlap(shortlist, withImports);
  digest.candidates = shortlist;
  return digest;
}

/**
 * Ranks by match strength first, then by relationship strength.
 *
 * An UNSCORED relationship sorts below a scored one rather than above: "we do
 * not know" is not evidence of a strong relationship. It is still eligible —
 * an unscored ICP match is a perfectly good cold-outreach suggestion — it just
 * does not outrank a warm one.
 */
function rankCandidates(a: SuggestionCandidate, b: SuggestionCandidate): number {
  if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
  return (b.relationshipScore ?? -1) - (a.relationshipScore ?? -1);
}

/**
 * Fills in "who else in the org knows this person".
 *
 * This is the genuinely org-level signal — the reason quick suggestions cannot
 * be computed one user at a time. Overlap is matched on `Connection.identityKey`
 * (the normalized profile URL for essentially every row), restricted to other
 * members' CURRENT snapshots.
 */
async function annotateOverlap(
  candidates: SuggestionCandidate[],
  members: { id: string; name: string; latestBatchId: string | null }[],
): Promise<void> {
  if (candidates.length === 0 || members.length < 2) return;

  const batchIds = members
    .map((member) => member.latestBatchId)
    .filter((id): id is string => id !== null);
  const memberByBatch = new Map(
    members
      .filter((member) => member.latestBatchId)
      .map((member) => [member.latestBatchId!, member]),
  );

  const identityKeys = await prisma.connection.findMany({
    where: { id: { in: candidates.map((candidate) => candidate.connectionId) } },
    select: { id: true, identityKey: true },
  });
  const keyByConnection = new Map(identityKeys.map((row) => [row.id, row.identityKey]));

  const holders = await prisma.connection.findMany({
    where: {
      importBatchId: { in: batchIds },
      identityKey: { in: [...new Set(keyByConnection.values())] },
    },
    select: { identityKey: true, importBatchId: true },
  });

  const holdersByKey = new Map<string, Set<string>>();
  for (const holder of holders) {
    const member = memberByBatch.get(holder.importBatchId);
    if (!member) continue;
    const set = holdersByKey.get(holder.identityKey) ?? new Set<string>();
    set.add(member.id);
    holdersByKey.set(holder.identityKey, set);
  }

  const nameById = new Map(members.map((member) => [member.id, member.name]));
  for (const candidate of candidates) {
    const key = keyByConnection.get(candidate.connectionId);
    if (!key) continue;
    const others = [...(holdersByKey.get(key) ?? [])].filter(
      (id) => id !== candidate.sourceUserId,
    );
    candidate.alsoKnownByCount = others.length;
    candidate.alsoKnownBy = others
      .slice(0, 3)
      .map((id) => nameById.get(id) ?? "another member");
  }
}
