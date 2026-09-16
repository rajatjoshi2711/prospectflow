import "server-only";

import type { CampaignLeadStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  deriveRelationshipStrength,
  resolveRelationshipStrength,
} from "@/lib/insights/relationship";
import { loadInteractionSignals } from "@/lib/insights/load-signals";
import { loadStoredRelationshipScores } from "@/lib/insights/load-stored-scores";
import { toPersonRef } from "@/lib/insights/signals";
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

function buildOrderBy(
  sort: ProspectSortKey,
  direction: "asc" | "desc",
): Prisma.CampaignLeadOrderByWithRelationInput[] {
  switch (sort) {
    case "company":
      return [{ company: direction }, { lastName: "asc" }];
    case "strength":
      // Strength lives on the linked `Connection`, so this orders through the
      // to-one relation. A lead that matched nobody in the network has no
      // connection and therefore a null score: NULLs last in both directions
      // keeps those cold leads out of the way rather than at the top of the
      // ascending list.
      return [
        { connection: { relationshipScore: { sort: direction, nulls: "last" } } },
        { lastName: "asc" },
      ];
    // Leads have no `connectedOn` of their own and no match score, so those
    // sort keys fall through to name — the table only offers name/company and
    // strength on this view anyway.
    default:
      return [{ firstName: direction }, { lastName: direction }];
  }
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

  const leads = await prisma.campaignLead.findMany({
    where,
    orderBy: buildOrderBy(sort, direction),
    skip: (safePage - 1) * pageSize,
    take: pageSize,
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

  // Stored relationship scores are keyed by (user, connection). The owning user
  // is read from the campaign itself rather than taken as a parameter, so this
  // function keeps its single source of scoping (see the note on `campaignId`).
  const owner =
    linked.length > 0
      ? await prisma.campaign.findUnique({
          where: { id: campaignId },
          select: { userId: true },
        })
      : null;
  const storedScores = owner
    ? await loadStoredRelationshipScores(
        owner.userId,
        linked.map((lead) => lead.connectionId!).filter(Boolean),
      )
    : new Map();

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
      identityKey: connection?.identityKey ?? lead.identityKey ?? undefined,
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
