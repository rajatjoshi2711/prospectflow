"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode } from "react";
import type { CampaignLeadStatus } from "@prisma/client";
import { LEAD_STATUS_BADGE_CLASS, LEAD_STATUS_LABEL } from "@/lib/insights/status";

/**
 * The shared prospect table.
 *
 * Every prospect-shaped dashboard renders the same thing: who they are, where
 * outreach stands, a link out to LinkedIn, and how strong the relationship is.
 * The all-connections view (Phase 3) is the first consumer; the ICP and
 * channel-partner dashboards (Phase 4) and campaigns (Phase 5) reuse it and
 * add their own column via `extraColumn` + `ProspectRow.extra` — no forking.
 *
 * Paging, sorting, and search are SERVER-side: this component only reads and
 * writes the URL query string. Connection counts run to the thousands, so the
 * page must never receive more than one page of rows.
 */

/**
 * `score` is used by the Phase 4 match dashboards, which sort by match score
 * in the extra column. It is not offered as a header on views that have no
 * score — `extraColumn.sortKey` opts a view in.
 */
export type ProspectSortKey = "name" | "company" | "connectedOn" | "score";

export type ProspectRow = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  position: string | null;
  linkedinUrl: string | null;
  status: CampaignLeadStatus;
  /** null = not yet scored (no interaction data in the import). */
  relationshipScore: number | null;
  /** Hover explanation for the score. */
  relationshipFactors?: string[];
  /** Rendered into the optional extra column. */
  extra?: ReactNode;
};

export type ProspectTableProps = {
  rows: ProspectRow[];
  /** Total rows matching the current filter, across all pages. */
  total: number;
  page: number;
  pageSize: number;
  sort: ProspectSortKey;
  direction: "asc" | "desc";
  /** Current search term (name or company). */
  query: string;
  /**
   * Optional trailing column, e.g. Phase 4's "which ICP". Give it a `sortKey`
   * to make its header sortable like the built-in ones.
   */
  extraColumn?: { header: string; sortKey?: ProspectSortKey };
  /** Rendered instead of the table when `total` is 0. */
  emptyState?: ReactNode;
  /** Hide the search box for views that filter some other way. */
  showSearch?: boolean;
  searchPlaceholder?: string;
};

const SORTABLE: { key: ProspectSortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "company", label: "Company" },
  { key: "connectedOn", label: "Connected" },
];

function displayName(row: ProspectRow) {
  const name = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : "Unnamed connection";
}

export function ProspectTable({
  rows,
  total,
  page,
  pageSize,
  sort,
  direction,
  query,
  extraColumn,
  emptyState,
  showSearch = true,
  searchPlaceholder = "Search by name or company…",
}: ProspectTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function pushParams(updates: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    const qs = next.toString();
    router.push(qs ? `?${qs}` : "?", { scroll: false });
  }

  function toggleSort(key: ProspectSortKey) {
    // Scores read best high-first, names low-first, so each column starts in
    // the direction people actually want.
    const preferred = key === "score" ? "desc" : "asc";
    const opposite = preferred === "asc" ? "desc" : "asc";
    const nextDirection = sort === key && direction === preferred ? opposite : preferred;
    pushParams({ sort: key, dir: nextDirection, page: "1" });
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);
  const columnCount = 4 + (extraColumn ? 1 : 0);

  return (
    <div className="flex flex-col gap-4">
      {showSearch ? (
        <form
          className="flex items-center gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get("q");
            pushParams({ q: (typeof value === "string" ? value.trim() : "") || null, page: "1" });
          }}
        >
          {/* Uncontrolled + keyed on `query` so a URL change (back button,
              Clear) resets the field without a state-syncing effect. */}
          <input
            key={query}
            name="q"
            className="ef-input"
            style={{ maxWidth: 360 }}
            defaultValue={query}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
          <button type="submit" className="ef-btn ef-btn-primary">
            Search
          </button>
          {query ? (
            <button
              type="button"
              className="ef-btn ef-btn-text"
              onClick={() => pushParams({ q: null, page: "1" })}
            >
              Clear
            </button>
          ) : null}
        </form>
      ) : null}

      {total === 0 ? (
        emptyState ?? (
          <div className="ef-card">
            <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
              No prospects match this view yet.
            </p>
          </div>
        )
      ) : (
        <>
          <div className="ef-card overflow-x-auto p-0">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr style={{ background: "var(--bg-subtle)" }}>
                  {SORTABLE.filter((column) => column.key !== "connectedOn").map((column) => (
                    <th key={column.key} className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                      <SortButton
                        label={column.label}
                        active={sort === column.key}
                        direction={direction}
                        onClick={() => toggleSort(column.key)}
                      />
                    </th>
                  ))}
                  <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                    Status
                  </th>
                  <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                    Relationship strength
                  </th>
                  {extraColumn ? (
                    <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                      {extraColumn.sortKey ? (
                        <SortButton
                          label={extraColumn.header}
                          active={sort === extraColumn.sortKey}
                          direction={direction}
                          onClick={() => toggleSort(extraColumn.sortKey!)}
                        />
                      ) : (
                        extraColumn.header
                      )}
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className="ef-small px-5 py-6" colSpan={columnCount} style={{ color: "var(--text-secondary)" }}>
                      Nothing on this page. Try going back a page.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.id} className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                      <td className="px-5 py-3">
                        <div className="ef-small" style={{ fontWeight: 600 }}>
                          {row.linkedinUrl ? (
                            <a
                              href={row.linkedinUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: "var(--blue-500)" }}
                            >
                              {displayName(row)}
                              <span aria-hidden style={{ marginLeft: 4 }}>
                                ↗
                              </span>
                              <span className="sr-only"> (opens LinkedIn profile in a new tab)</span>
                            </a>
                          ) : (
                            displayName(row)
                          )}
                        </div>
                        {row.position ? <div className="ef-caption">{row.position}</div> : null}
                        {!row.linkedinUrl ? (
                          <div className="ef-caption" style={{ color: "var(--neutral-400)" }}>
                            No LinkedIn URL in export
                          </div>
                        ) : null}
                      </td>
                      <td className="ef-small px-5 py-3">{row.company ?? "—"}</td>
                      <td className="px-5 py-3">
                        <span className={`ef-badge ${LEAD_STATUS_BADGE_CLASS[row.status]}`}>
                          {LEAD_STATUS_LABEL[row.status]}
                        </span>
                      </td>
                      <td className="px-5 py-3" style={{ minWidth: 180 }}>
                        <StrengthBar score={row.relationshipScore} factors={row.relationshipFactors} />
                      </td>
                      {extraColumn ? <td className="ef-small px-5 py-3">{row.extra ?? "—"}</td> : null}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-4">
            <p className="ef-caption">
              Showing {firstRow.toLocaleString()}–{lastRow.toLocaleString()} of{" "}
              {total.toLocaleString()}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="ef-btn ef-btn-secondary"
                disabled={page <= 1}
                onClick={() => pushParams({ page: String(page - 1) })}
              >
                Previous
              </button>
              <span className="ef-caption">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                className="ef-btn ef-btn-secondary"
                disabled={page >= totalPages}
                onClick={() => pushParams({ page: String(page + 1) })}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SortButton({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1"
      style={{ fontWeight: 700, color: active ? "var(--blue-500)" : "var(--text-primary)", cursor: "pointer" }}
      aria-label={`Sort by ${label}`}
    >
      {label}
      <span aria-hidden style={{ opacity: active ? 1 : 0.35 }}>
        {active && direction === "desc" ? "▾" : "▴"}
      </span>
    </button>
  );
}

/** Relationship strength out of 100, or an explicit "not yet scored" state. */
function StrengthBar({ score, factors }: { score: number | null; factors?: string[] }) {
  if (score === null) {
    return (
      <span className="ef-caption" title="Relationship scoring arrives with the AI pipeline.">
        Not yet scored
      </span>
    );
  }

  return (
    <div title={factors && factors.length > 0 ? factors.join(" · ") : undefined}>
      <div
        role="meter"
        aria-valuenow={score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Relationship strength out of 100"
        style={{
          height: 8,
          borderRadius: 999,
          background: "var(--neutral-100)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${score}%`,
            height: "100%",
            borderRadius: 999,
            background: score >= 60 ? "var(--green-500)" : score >= 30 ? "var(--blue-400)" : "var(--neutral-300)",
          }}
        />
      </div>
      <div className="ef-caption mt-1">{score} / 100</div>
    </div>
  );
}
