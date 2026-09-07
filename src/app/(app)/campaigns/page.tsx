import Link from "next/link";
import { redirect } from "next/navigation";
import type { CampaignStatus } from "@prisma/client";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

/**
 * The user's own campaigns. Campaigns are PERSONAL — unlike ICPs and channel
 * partners, which are org-level — so this only ever queries by `userId`.
 */

const STATUS_BADGE: Record<CampaignStatus, { className: string; label: string }> = {
  PENDING: { className: "ef-badge-neutral", label: "Uploading" },
  DETECTING: { className: "ef-badge-warning", label: "Reading file" },
  AWAITING_CONFIRMATION: { className: "ef-badge-info", label: "Confirm column" },
  PROCESSING: { className: "ef-badge-warning", label: "Creating leads" },
  COMPLETE: { className: "ef-badge-success", label: "Ready" },
  FAILED: { className: "ef-badge-danger", label: "Failed" },
};

export default async function CampaignsPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const campaigns = await prisma.campaign.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      status: true,
      leadCount: true,
      matchedLeadCount: true,
      errorMessage: true,
      createdAt: true,
      _count: { select: { leads: true } },
    },
  });

  return (
    <div>
      <p className="ef-eyebrow mb-2">Phase 5 — campaigns</p>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="ef-page mb-2">Campaigns</h1>
          <p className="ef-lead" style={{ maxWidth: 680 }}>
            Upload a lead list and track every prospect from connection request
            through to an ongoing conversation.
          </p>
        </div>
        <Link href="/campaigns/new" className="ef-btn ef-btn-primary">
          New campaign
        </Link>
      </div>

      {campaigns.length === 0 ? (
        <div className="ef-card ef-rise flex flex-col items-start gap-3" style={{ maxWidth: 560 }}>
          <span className="ef-badge ef-badge-info">Get started</span>
          <p className="ef-subhead">No campaigns yet</p>
          <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
            Bring an .xlsx or .csv lead list with a LinkedIn profile URL column.
            ProspectFlow finds that column for you, links each lead to anyone
            already in your network, and gives you one place to move them
            through outreach.
          </p>
          <Link href="/campaigns/new" className="ef-btn ef-btn-primary">
            Upload your first lead list
          </Link>
        </div>
      ) : (
        <div className="ef-card overflow-x-auto p-0">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr style={{ background: "var(--bg-subtle)" }}>
                <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>Campaign</th>
                <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>Leads</th>
                <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>In your network</th>
                <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>Status</th>
                <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>Created</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => {
                const badge = STATUS_BADGE[campaign.status];
                const leads = campaign.leadCount ?? campaign._count.leads;
                return (
                  <tr
                    key={campaign.id}
                    className="border-t"
                    style={{ borderColor: "var(--border-subtle)" }}
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/campaigns/${campaign.id}`}
                        className="ef-small"
                        style={{ color: "var(--blue-500)", fontWeight: 600 }}
                      >
                        {campaign.name}
                      </Link>
                      {campaign.status === "FAILED" && campaign.errorMessage ? (
                        <div className="ef-caption" style={{ color: "var(--danger)" }}>
                          {campaign.errorMessage}
                        </div>
                      ) : null}
                    </td>
                    <td className="ef-small px-5 py-3">
                      {campaign.status === "COMPLETE" ? leads.toLocaleString() : "—"}
                    </td>
                    <td className="ef-small px-5 py-3">
                      {campaign.status === "COMPLETE" && campaign.matchedLeadCount !== null
                        ? `${campaign.matchedLeadCount.toLocaleString()} of ${leads.toLocaleString()}`
                        : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`ef-badge ${badge.className}`}>{badge.label}</span>
                    </td>
                    <td className="ef-small px-5 py-3">
                      {campaign.createdAt.toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
