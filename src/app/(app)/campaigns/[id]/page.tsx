import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { PROSPECT_PAGE_SIZE, parseProspectSearchParams } from "@/lib/insights/prospects";
import {
  countLeadsByStatus,
  fetchCampaignLeadPage,
  parseStatusFilter,
} from "@/lib/campaigns/leads";
import type { SpreadsheetRow } from "@/lib/campaigns/parse-spreadsheet";
import type { ColumnDetection } from "@/lib/campaigns/detection-types";
import { CampaignColumnConfirm } from "@/components/campaign-column-confirm";
import { CampaignLeadTable } from "@/components/campaign-lead-table";
import { CampaignStatusPoller } from "@/components/campaign-status-poller";

/**
 * One campaign.
 *
 * Renders whichever stage the campaign is at: still ingesting, waiting for the
 * user to confirm the LinkedIn-URL column, failed, or ready with the lead
 * table. Ownership is enforced by the query — `userId` is part of the WHERE
 * clause, so another user's campaign id is a 404, not a peek.
 */
export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;
  const campaign = await prisma.campaign.findFirst({
    where: { id, userId: session.userId },
  });
  if (!campaign) {
    notFound();
  }

  const header = (
    <>
      <p className="ef-eyebrow mb-2">Campaign</p>
      <h1 className="ef-page mb-2">{campaign.name}</h1>
      <p className="ef-caption mb-8">
        {campaign.sourceFileName ? `${campaign.sourceFileName} · ` : ""}
        Uploaded {campaign.createdAt.toLocaleDateString()} · Visible only to you
      </p>
    </>
  );

  if (campaign.status === "PENDING" || campaign.status === "DETECTING") {
    return (
      <div>
        {header}
        <CampaignStatusPoller campaignId={campaign.id} currentStatus={campaign.status} />
        <div className="ef-card ef-rise flex flex-col items-start gap-3" style={{ maxWidth: 520 }}>
          <span className="ef-badge ef-badge-warning">Reading your file</span>
          <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
            Working out which column holds the LinkedIn profile URLs. This page
            updates itself when it is done.
          </p>
        </div>
      </div>
    );
  }

  if (campaign.status === "FAILED") {
    return (
      <div>
        {header}
        <div className="ef-card ef-rise flex flex-col items-start gap-3" style={{ maxWidth: 560 }}>
          <span className="ef-badge ef-badge-danger">Failed</span>
          <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
            {campaign.errorMessage ?? "Something went wrong while reading that file."}
          </p>
          <Link href="/campaigns/new" className="ef-btn ef-btn-primary">
            Upload a different file
          </Link>
        </div>
      </div>
    );
  }

  if (campaign.status === "AWAITING_CONFIRMATION") {
    const detection: ColumnDetection = {
      column: campaign.detectedColumn,
      confidence: campaign.detectionConfidence ?? 0,
      method: (campaign.detectionMethod ?? "none") as ColumnDetection["method"],
    };
    return (
      <div>
        {header}
        <CampaignColumnConfirm
          campaignId={campaign.id}
          headers={campaign.columnHeaders}
          sampleRows={(campaign.sampleRows ?? []) as SpreadsheetRow[]}
          detection={detection}
        />
      </div>
    );
  }

  if (campaign.status === "PROCESSING") {
    return (
      <div>
        {header}
        <CampaignStatusPoller campaignId={campaign.id} currentStatus={campaign.status} />
        <div className="ef-card ef-rise flex flex-col items-start gap-3" style={{ maxWidth: 520 }}>
          <span className="ef-badge ef-badge-warning">Creating leads</span>
          <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
            Reading every row from &ldquo;{campaign.linkedinColumn}&rdquo; and matching leads
            against your network. This page updates itself when it is done.
          </p>
        </div>
      </div>
    );
  }

  // COMPLETE
  const rawParams = await searchParams;
  const listParams = parseProspectSearchParams(rawParams);
  const statusValue = Array.isArray(rawParams.status) ? rawParams.status[0] : rawParams.status;
  const statusFilter = parseStatusFilter(statusValue);

  const [{ rows, total, page }, statusCounts] = await Promise.all([
    fetchCampaignLeadPage({
      // Already scoped to the signed-in user by the findFirst above.
      campaignId: campaign.id,
      page: listParams.page,
      sort: listParams.sort,
      direction: listParams.direction,
      query: listParams.query,
      status: statusFilter,
      linkedinColumn: campaign.linkedinColumn,
    }),
    countLeadsByStatus(campaign.id),
  ]);

  const totalLeads = campaign.leadCount ?? Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const matched = campaign.matchedLeadCount ?? 0;

  return (
    <div>
      {header}

      <div className="mb-6 flex flex-wrap gap-4">
        <SummaryCard label="Leads" value={totalLeads.toLocaleString()} />
        <SummaryCard
          label="Already in your network"
          value={`${matched.toLocaleString()}`}
          caption={
            totalLeads > 0
              ? `${Math.round((matched / totalLeads) * 100)}% matched to a connection`
              : undefined
          }
        />
        <SummaryCard
          label="LinkedIn URL column"
          value={campaign.linkedinColumn ?? "—"}
          caption={
            campaign.detectedColumn && campaign.detectedColumn !== campaign.linkedinColumn
              ? `You overrode the detected "${campaign.detectedColumn}"`
              : campaign.detectionMethod === "llm"
                ? "Suggested by AI, confirmed by you"
                : "Detected from the data, confirmed by you"
          }
        />
      </div>

      {campaign.errorMessage ? (
        <div
          className="ef-small mb-6 rounded-[10px] px-4 py-3"
          style={{ background: "var(--warning-soft)", color: "var(--warning)" }}
        >
          {campaign.errorMessage}
        </div>
      ) : null}

      {matched < totalLeads ? (
        <p className="ef-caption mb-4">
          Relationship strength is only shown for leads already in your network —
          the rest have no interaction history to score. Import a newer LinkedIn
          export from{" "}
          <Link href="/imports" style={{ color: "var(--blue-500)" }}>
            Imports
          </Link>{" "}
          to match more of them.
        </p>
      ) : null}

      <CampaignLeadTable
        campaignId={campaign.id}
        rows={rows}
        total={total}
        page={page}
        pageSize={PROSPECT_PAGE_SIZE}
        sort={listParams.sort}
        direction={listParams.direction}
        query={listParams.query}
        statusFilter={statusFilter}
        statusCounts={statusCounts}
        totalLeads={totalLeads}
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption?: string;
}) {
  return (
    <div className="ef-card" style={{ minWidth: 200, flex: "1 1 200px" }}>
      <div className="ef-eyebrow mb-1">{label}</div>
      <div className="ef-h3" style={{ wordBreak: "break-word" }}>
        {value}
      </div>
      {caption ? <div className="ef-caption mt-1">{caption}</div> : null}
    </div>
  );
}
