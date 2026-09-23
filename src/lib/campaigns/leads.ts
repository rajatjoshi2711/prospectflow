import "server-only";

import { Prisma, type CampaignLeadStatus, type ConnectionMarkValue } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  deriveRelationshipStrength,
  resolveRelationshipStrength,
} from "@/lib/insights/relationship";
import { loadInteractionSignals } from "@/lib/insights/load-signals";
import { loadStoredRelationshipScores } from "@/lib/insights/load-stored-scores";
import { toPersonRef } from "@/lib/insights/signals";
import { loadConnectionMarks } from "@/lib/insights/marks";
import { joinUserMarksSql, usefulnessFirstByExpr, userMarksSql } from "@/lib/insights/mark-order";
import { connectionSearchSql } from "@/lib/insights/prospects";
import { summarizeRawRow } from "@/lib/campaigns/fields";
import type { SpreadsheetRow } from "@/lib/campaigns/parse-spreadsheet";
import type { ProspectSortKey } from "@/components/prospect-table";
import { PROSPECT_PAGE_SIZE } from "@/lib/insights/prospects";

/** One campaign lead as the campaign table renders it. */
export type CampaignLeadRow = {
  id: string;
  /**
   * The person's stable key: the linked `Connection.identityKey` when the lead
   * matched someone in the user's network, otherwise the lead's own
   * `CampaignLead.identityKey`. Carried so the campaign table can link the
   * name to their prospect page — an unmatched lead has one too, built from
   * whatever the spreadsheet carried. Still optional: leads created before the
   * column existed can have neither, and those render as plain text.
   */
  identityKey?: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  position: string | null;
  linkedinUrl: string | null;
  status: CampaignLeadStatus;
  relationshipScore: number | null;
  relationshipFactors?: string[];
  /** `ai`, `heuristic`, or null when unscored. See `ProspectRow`. */
  relationshipBasis?: "ai" | "heuristic" | null;
  /**
   * The owner's thumbs up / thumbs down on this person, read on the same key
   * the row links by. Null when they have not judged them, which is also the
   * band the list orders them into.
   */
  mark: ConnectionMarkValue | null;
  /** True when this lead resolved to a Connection in the user's own network. */
  inNetwork: boolean;
  /** A line of context lifted from the original spreadsheet row. */
  context: string | null;
};

export const CAMPAIGN_LEAD_STATUSES: CampaignLeadStatus[] = [
  "REQUEST_PENDING",
  "REQUEST_ACCEPTED",
  "FIRST_MESSAGE_SENT",
  "CONVERSATION_ONGOING",
];

export function parseStatusFilter(value: string | undefined): CampaignLeadStatus | null {
  return CAMPAIGN_LEAD_STATUSES.includes(value as CampaignLeadStatus)
    ? (value as CampaignLeadStatus)
    : null;
}

function buildWhere(
  campaignId: string,
  query: string,
  status: CampaignLeadStatus | null,
): Prisma.CampaignLeadWhereInput {
  const terms = query.split(/\s+/).filter(Boolean).slice(0, 5);
  return {
    campaignId,
    ...(status ? { status } : {}),
    // Every term must match somewhere, so "jane acme" finds Jane at Acme
    // rather than everyone called Jane. Same rule as the connections table.
    ...(terms.length > 0
      ? {
          AND: terms.map((term) => ({
            OR: [
              { firstName: { contains: term, mode: "insensitive" as const } },
              { lastName: { contains: term, mode: "insensitive" as const } },
              { company: { contains: term, mode: "insensitive" as const } },
            ],
          })),
        }
      : {}),
  };
}

/**
 * The SECONDARY ordering — what the reader's chosen column does INSIDE each
 * Usefulness band, which `usefulnessFirstByExpr` puts in front.
 *
 * `l` is the lead, `c` the connection it linked to (LEFT JOINed, so null for a
 * cold lead). Strength lives on the connection: a lead that matched nobody in
 * the network has no score at all, and NULLS LAST in both directions keeps
 * those out of the way rather than at the top of the ascending list.
 *
 * Leads have no `connectedOn` of their own and no match score, so those sort
 * keys fall through to name — the table only offers name, company and strength
 * on this view anyway.
 *
 * Every clause ends on `l."id"`, a unique value, so paging is stable on ties.
 */
const LEAD_ORDER_BY: Partial<Record<ProspectSortKey, (d: string) => string>> = {
  name: (d) => `l."firstName" ${d} NULLS LAST, l."lastName" ${d} NULLS LAST`,
  company: (d) => `l."company" ${d} NULLS LAST, l."lastName" ASC NULLS LAST`,
  strength: (d) => `c."relationshipScore" ${d} NULLS LAST, l."lastName" ASC NULLS LAST`,
};

function leadOrderBySql(sort: ProspectSortKey, direction: "asc" | "desc"): Prisma.Sql {
  const clause = (LEAD_ORDER_BY[sort] ?? LEAD_ORDER_BY.name)!;
  // `Prisma.raw` over a literal from the table above, selected by an
  // already-validated key — never over anything from the query string.
  return usefulnessFirstByExpr(
    `${clause(direction === "desc" ? "DESC" : "ASC")}, l."id" ASC`,
  );
}

/**
 * The ids of one page of leads, ordered Usefulness-first.
 *
 * WHICH KEY THE MARK IS LOOKED UP BY: `COALESCE(connection.identityKey,
 * lead.identityKey)` — the same key the row itself renders its prospect link
 * with, and the same one `fetchCampaignLeadPage` reads the mark back on. A
 * lead that matched someone in the network is marked against the connection's
 * key, so a thumbs-down given on `/connections` also sinks that person here; a
 * cold lead is marked against its own key, which is what its prospect page is
 * addressed by. Getting this wrong either way would show a mark the ordering
 * did not use, or order by a mark the row does not show.
 *
 * UNLINKED LEADS ARE NOT A FOURTH BAND. A lead with no connection, and a lead
 * with no key at all (imported before `CampaignLead.identityKey` existed), both
 * simply have no mark and land in the middle "unmarked" band — which is the
 * truth: nobody has judged them. They are not pushed down with the
 * thumbs-downs, because "not yet in your network" is not "not useful".
 *
 * COST: one index scan of `CampaignLead` on the campaign (plus the status
 * equality when filtered), a primary-key lookup per linked lead into
 * `Connection`, and a hash join to the member's own marks — an index scan of
 * `ConnectionMark` on the `userId` prefix of `@@unique([userId, identityKey])`,
 * which also carries `value`, so it is index-only and needs no new index.
 */
async function fetchCampaignLeadIds({
  userId,
  campaignId,
  query,
  status,
  sort,
  direction,
  limit,
  offset,
}: {
  userId: string;
  campaignId: string;
  query: string;
  status: CampaignLeadStatus | null;
  sort: ProspectSortKey;
  direction: "asc" | "desc";
  limit: number;
  offset: number;
}): Promise<string[]> {
  const statusFilter = status
    ? Prisma.sql`AND l."status" = ${status}::"CampaignLeadStatus"`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH ${userMarksSql(userId)}
    SELECT l."id" AS id
    FROM "CampaignLead" l
    LEFT JOIN "Connection" c ON c."id" = l."connectionId"
    ${joinUserMarksSql(`COALESCE(c."identityKey", l."identityKey")`)}
    WHERE l."campaignId" = ${campaignId}
      ${statusFilter}
      ${connectionSearchSql(query, "l")}
    ORDER BY ${leadOrderBySql(sort, direction)}
    LIMIT ${limit} OFFSET ${offset}
  `);

  return rows.map((row) => row.id);
}

/**
 * One page of campaign leads, with status and relationship strength.
 *
 * SCOPING: `campaignId` must already have been resolved against the signed-in
 * user by the caller (the page does this). Nothing here re-checks ownership, so
 * it must never be handed a campaign id straight off a request.
 *
 * RELATIONSHIP STRENGTH: only leads that linked to a `Connection` in the user's
 * latest completed import have any signal behind them. For everyone else — a
 * prospect who is not in the user's network yet, which is the normal case for a
 * cold lead list — the score is `null` and the table renders "not yet scored".
 * Showing a zero there would read as "weak relationship" when the truth is "no
 * data", so it is never done.
 */
export async function fetchCampaignLeadPage({
  campaignId,
  page,
  sort,
  direction,
  query,
  status,
  linkedinColumn,
  pageSize = PROSPECT_PAGE_SIZE,
}: {
  /**
   * MUST already have been resolved against the signed-in user (the page does
   * this with a `findFirst` filtered on `userId`). There is deliberately no
   * `userId` parameter here: a second, redundant scoping argument invites a
   * caller to pass an unvalidated id and assume this function checks it.
   */
  campaignId: string;
  page: number;
  sort: ProspectSortKey;
  direction: "asc" | "desc";
  query: string;
  status: CampaignLeadStatus | null;
  linkedinColumn: string | null;
  pageSize?: number;
}): Promise<{ rows: CampaignLeadRow[]; total: number; page: number }> {
  const where = buildWhere(campaignId, query, status);

  const total = await prisma.campaignLead.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  if (total === 0) return { rows: [], total, page: safePage };

  // The owning user is read from the campaign itself rather than taken as a
  // parameter, so this function keeps its single source of scoping (see the
  // note on `campaignId`). It is needed BEFORE the page query now, because the
  // Usefulness band that leads the ordering is the owner's own marks.
  const owner = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { userId: true },
  });
  if (!owner) return { rows: [], total: 0, page: 1 };

  // Ordered in SQL: the Usefulness band is a join on
  // `ConnectionMark.identityKey` with no Prisma relation behind it, so
  // `orderBy` cannot reach it. Only this page's ids come back.
  const orderedIds = await fetchCampaignLeadIds({
    userId: owner.userId,
    campaignId,
    query,
    status,
    sort,
    direction,
    limit: pageSize,
    offset: (safePage - 1) * pageSize,
  });
  if (orderedIds.length === 0) return { rows: [], total, page: safePage };

  const unordered = await prisma.campaignLead.findMany({
    // The campaign scope, status filter and search terms are re-applied
    // alongside the id list, so scoping is enforced here too and not only
    // inside the raw query.
    where: { AND: [where, { id: { in: orderedIds } }] },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      company: true,
      position: true,
      linkedinUrl: true,
      identityKey: true,
      status: true,
      rawRow: true,
      connectionId: true,
      connection: {
        select: {
          identityKey: true,
          nameKey: true,
          firstName: true,
          lastName: true,
          connectedOn: true,
          importBatchId: true,
          relationshipScore: true,
          relationshipBasis: true,
        },
      },
    },
  });

  // `IN (...)` carries no order, so the SQL ordering is reapplied over the ≤25
  // rows of this page — a reshuffle of what the ORDER BY already decided, not a
  // re-sort of the data set.
  const leads = orderedIds
    .map((id) => unordered.find((lead) => lead.id === id))
    .filter((lead): lead is (typeof unordered)[number] => lead !== undefined);

  // Signals are per import batch. Every linked connection on this page comes
  // from the user's latest completed import (that is the only batch
  // `buildConnectionIndex` links against), so one batch id covers the page.
  const linked = leads.filter((lead) => lead.connection !== null);
  const batchId = linked[0]?.connection?.importBatchId ?? null;
  const signals = batchId
    ? await loadInteractionSignals(
        batchId,
        linked.map((lead) => toPersonRef(lead.connection!)),
      )
    : null;

  // Stored relationship scores are keyed by (user, connection), so they are
  // scoped to the campaign's owner.
  const storedScores =
    linked.length > 0
      ? await loadStoredRelationshipScores(
          owner.userId,
          linked.map((lead) => lead.connectionId!).filter(Boolean),
        )
      : new Map();

  // The SAME key the ordering joined on and the same one the row links by, so
  // the thumb shown on a row is always the one that placed it in its band.
  const markKey = (lead: (typeof leads)[number]) =>
    lead.connection?.identityKey ?? lead.identityKey ?? undefined;
  const marks = await loadConnectionMarks(
    owner.userId,
    leads.map(markKey).filter((key): key is string => Boolean(key)),
  );

  const rows: CampaignLeadRow[] = leads.map((lead) => {
    const connection = lead.connection;
    // Materialized column first, so the rows agree with the strength sort.
    const strength =
      connection && signals
        ? resolveRelationshipStrength({
            materialized: {
              score: connection.relationshipScore,
              basis: connection.relationshipBasis,
            },
            derived: deriveRelationshipStrength({
              signals,
              identityKey: connection.identityKey,
              connectedOn: connection.connectedOn,
              stored: (lead.connectionId
                ? storedScores.get(lead.connectionId)
                : null) ?? null,
            }),
          })
        : null;

    const rawRow = (lead.rawRow ?? {}) as SpreadsheetRow;

    return {
      id: lead.id,
      // The connection's key FIRST where there is one: that is the key every
      // other surface (marks, notes, org coverage) is stored against, and it
      // can differ from the lead's own, which is derived from whatever URL the
      // sheet happened to carry. An unmatched lead falls back to its own key,
      // which is what addresses its prospect page — that page renders from the
      // spreadsheet row and is where notes and research on a cold lead live.
      // `?? undefined` because `CampaignLead.identityKey` is nullable for rows
      // written before the column existed, and `ProspectTable` renders a row
      // with no key as plain text rather than a link that 404s.
      identityKey: markKey(lead),
      mark: (markKey(lead) && marks.get(markKey(lead)!)) || null,
      firstName: lead.firstName,
      lastName: lead.lastName,
      company: lead.company,
      position: lead.position,
      linkedinUrl: lead.linkedinUrl,
      // The column is authoritative: `relinkUserCampaignLeads` materializes the
      // derived status into it after every import, and a hand-set status wins
      // there. Deriving again here would let the rows disagree with the status
      // chips and the status filter, which necessarily read the column.
      status: lead.status,
      relationshipScore: strength?.score ?? null,
      relationshipFactors: strength?.factors,
      relationshipBasis: strength?.basis ?? null,
      inNetwork: lead.connectionId !== null,
      context: summarizeRawRow(rawRow, linkedinColumn, {
        firstName: lead.firstName,
        lastName: lead.lastName,
        company: lead.company,
        position: lead.position,
      }),
    };
  });

  return { rows, total, page: safePage };
}

/** Lead counts per status, for the filter chips above the table. */
export async function countLeadsByStatus(campaignId: string) {
  const grouped = await prisma.campaignLead.groupBy({
    by: ["status"],
    where: { campaignId },
    _count: { _all: true },
  });
  const counts = Object.fromEntries(
    CAMPAIGN_LEAD_STATUSES.map((status) => [status, 0]),
  ) as Record<CampaignLeadStatus, number>;
  for (const entry of grouped) counts[entry.status] = entry._count._all;
  return counts;
}
