"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { CampaignLeadStatus } from "@prisma/client";
import { ProspectTable, type ProspectRow, type ProspectSortKey } from "@/components/prospect-table";
import { LEAD_STATUS_BADGE_CLASS, LEAD_STATUS_LABEL } from "@/lib/insights/status";
import type { CampaignLeadRow } from "@/lib/campaigns/leads";

/**
 * The campaign lead table.
 *
 * Reuses the shared `ProspectTable` wholesale — same columns, same server-side
 * paging and sorting — and swaps in two campaign-specific pieces:
 *   - `renderStatus`, an inline editor, because moving leads through the
 *     pipeline is what a campaign is for;
 *   - `toolbar`, status filter chips.
 *
 * The status control writes optimistically and rolls back if the API rejects
 * the change, so a status the server did not accept never sits on screen
 * looking saved.
 */

const STATUS_ORDER: CampaignLeadStatus[] = [
  "REQUEST_PENDING",
  "REQUEST_ACCEPTED",
  "FIRST_MESSAGE_SENT",
  "CONVERSATION_ONGOING",
];

export type CampaignLeadTableProps = {
  campaignId: string;
  rows: CampaignLeadRow[];
  total: number;
  page: number;
  pageSize: number;
  sort: ProspectSortKey;
  direction: "asc" | "desc";
  query: string;
  statusFilter: CampaignLeadStatus | null;
  statusCounts: Record<CampaignLeadStatus, number>;
  totalLeads: number;
};

export function CampaignLeadTable({
  campaignId,
  rows,
  total,
  page,
  pageSize,
  sort,
  direction,
  query,
  statusFilter,
  statusCounts,
  totalLeads,
}: CampaignLeadTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Local overrides on top of the server-rendered rows, so a change shows
  // immediately without waiting for a refresh round-trip.
  const [overrides, setOverrides] = useState<Record<string, CampaignLeadStatus>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const byId = new Map(rows.map((row) => [row.id, row]));

  const prospectRows: ProspectRow[] = rows.map((row) => ({
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    company: row.company,
    position: row.position,
    linkedinUrl: row.linkedinUrl,
    status: overrides[row.id] ?? row.status,
    relationshipScore: row.relationshipScore,
    relationshipFactors: row.relationshipFactors,
    extra: (
      <div>
        <div>{row.context ?? "—"}</div>
        <div
          className="ef-caption"
          style={{ color: row.inNetwork ? "var(--green-600)" : "var(--neutral-400)" }}
        >
          {row.inNetwork ? "In your network" : "Not in your network yet"}
        </div>
      </div>
    ),
  }));

  async function updateStatus(leadId: string, next: CampaignLeadStatus) {
    const previous = overrides[leadId] ?? byId.get(leadId)?.status;
    setError(null);
    setOverrides((current) => ({ ...current, [leadId]: next }));
    setSaving((current) => ({ ...current, [leadId]: true }));

    try {
      const res = await fetch(`/api/campaigns/${campaignId}/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Could not save that status.");
      }
      // Keep the status-filter counts (rendered on the server) honest.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that status.");
      setOverrides((current) => {
        const rolledBack = { ...current };
        if (previous) rolledBack[leadId] = previous;
        else delete rolledBack[leadId];
        return rolledBack;
      });
    } finally {
      setSaving((current) => {
        const next = { ...current };
        delete next[leadId];
        return next;
      });
    }
  }

  function setStatusFilter(next: CampaignLeadStatus | null) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next) params.set("status", next);
    else params.delete("status");
    params.set("page", "1");
    router.push(`?${params.toString()}`, { scroll: false });
  }

  const toolbar = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip
          label="All"
          count={totalLeads}
          active={statusFilter === null}
          onClick={() => setStatusFilter(null)}
        />
        {STATUS_ORDER.map((status) => (
          <FilterChip
            key={status}
            label={LEAD_STATUS_LABEL[status]}
            count={statusCounts[status]}
            active={statusFilter === status}
            onClick={() => setStatusFilter(status)}
          />
        ))}
      </div>
      {error ? (
        <div
          className="ef-small rounded-[10px] px-4 py-3"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </div>
  );

  return (
    <ProspectTable
      rows={prospectRows}
      total={total}
      page={page}
      pageSize={pageSize}
      sort={sort}
      direction={direction}
      query={query}
      searchPlaceholder="Search leads by name or company…"
      extraColumn={{ header: "From your file" }}
      toolbar={toolbar}
      renderStatus={(row) => (
        <div className="flex flex-col gap-1">
          <select
            className="ef-input"
            style={{ minWidth: 210, padding: "6px 10px", fontSize: "var(--fs-small)" }}
            value={row.status}
            disabled={Boolean(saving[row.id])}
            aria-label={`Outreach status for ${[row.firstName, row.lastName].filter(Boolean).join(" ") || "this lead"}`}
            onChange={(event) =>
              void updateStatus(row.id, event.target.value as CampaignLeadStatus)
            }
          >
            {STATUS_ORDER.map((status) => (
              <option key={status} value={status}>
                {LEAD_STATUS_LABEL[status]}
              </option>
            ))}
          </select>
          <span
            className={`ef-badge ${LEAD_STATUS_BADGE_CLASS[row.status]}`}
            style={{ alignSelf: "flex-start" }}
          >
            {saving[row.id] ? "Saving…" : LEAD_STATUS_LABEL[row.status]}
          </span>
        </div>
      )}
      emptyState={
        <div className="ef-card">
          <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
            {query || statusFilter
              ? "No leads match this filter. Clear it to see the whole campaign."
              : "This campaign has no leads."}
          </p>
        </div>
      }
    />
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="ef-small rounded-[999px] px-3 py-1.5 transition-colors"
      style={{
        cursor: "pointer",
        border: `1px solid ${active ? "var(--blue-500)" : "var(--border)"}`,
        background: active ? "var(--blue-50)" : "#fff",
        color: active ? "var(--blue-500)" : "var(--text-secondary)",
        fontWeight: active ? 700 : 500,
      }}
    >
      {label}
      <span className="ef-caption" style={{ marginLeft: 6 }}>
        {count.toLocaleString()}
      </span>
    </button>
  );
}
