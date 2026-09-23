"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode } from "react";
import type { CampaignLeadStatus, ConnectionMarkValue } from "@prisma/client";
import { LEAD_STATUS_BADGE_CLASS, LEAD_STATUS_LABEL } from "@/lib/insights/status";
import { ConnectionMarkButtons } from "@/components/connection-mark-buttons";
import { prospectHref } from "@/lib/prospects/person-key";

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
 *
 * `strength` orders by the materialized `Connection.relationshipScore` column
 * rather than the value each row derives at render time, which is why the
 * column had to exist at all: paging is server-side, so only something SQL can
 * see is sortable. Opt a view in with `strengthSortable`.
 *
 * `waiting` and `lastMessage` belong to the Phase 8 action pages, whose whole
 * point is an ordering no column on `/connections` expresses — how long someone
 * has been waiting, how long a relationship has been quiet. Descending means
 * "most of it" (longest waiting, longest dormant), which is the OLDEST date;
 * `prospecting-actions.ts` owns that inversion so only one place decides it.
 */
export type ProspectSortKey =
  | "name"
  | "company"
  | "connectedOn"
  | "score"
  | "strength"
  | "waiting"
  | "lastMessage";

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
  /**
   * How the number was derived: `ai` for a stored model-produced score,
   * `heuristic` for the transparent rule-based fallback, `null` when there is
   * no score at all. Surfaced in the table (Phase 7) because a 72 from a model
   * and a 72 from an arithmetic rule are different claims, and the suggestions
   * panel was previously the only place that said which.
   */
  relationshipBasis?: "ai" | "heuristic" | null;
  /**
   * The person's stable cross-import key.
   *
   * Two things depend on it: the `markable` usefulness column, and the link on
   * the person's name to `/prospects/<key>`. A campaign lead that matched
   * nobody in the network has one too — its own key off the spreadsheet — and
   * gets a page with the fields the sheet carried. It stays optional because a
   * row can genuinely have no key at all (a lead imported before
   * `CampaignLead.identityKey` existed), and such a row renders as plain text
   * rather than as a link that 404s.
   */
  identityKey?: string;
  /** The signed-in user's thumbs up/down on this person. Undefined = view does not show marks. */
  mark?: ConnectionMarkValue | null;
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
  /**
   * Makes the relationship-strength header sortable. Off by default: a view
   * whose query cannot reach `Connection.relationshipScore` would offer a
   * header that silently does nothing, the same reason `connectedOn` is not
   * shown everywhere.
   */
  strengthSortable?: boolean;
  /**
   * Adds the thumbs up / thumbs down column. Off by default, the same reason
   * `strengthSortable` is: only a view whose query actually loads marks (and
   * supplies `ProspectRow.identityKey`) can render the control honestly, and a
   * campaign lead row is a spreadsheet row, not necessarily a person in the
   * user's own network.
   */
  markable?: boolean;
  /** Hide the search box for views that filter some other way. */
  showSearch?: boolean;
  searchPlaceholder?: string;
  /**
   * Replaces the read-only status badge. Campaigns (Phase 5) pass an editable
   * control here, because moving a lead through the outreach pipeline is the
   * whole point of that view. Connections and match dashboards derive status
   * from the import and have nothing to edit, so they omit it and keep the
   * badge.
   */
  renderStatus?: (row: ProspectRow) => ReactNode;
  /** Rendered above the table (e.g. campaign status filter chips). */
  toolbar?: ReactNode;
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
  strengthSortable = false,
  markable = false,
  showSearch = true,
  searchPlaceholder = "Search by name or company…",
  renderStatus,
  toolbar,
}: ProspectTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // Handed to the prospect page as `?from=`, so its back link returns to THIS
  // list on THIS page of results rather than to a generic landing page. The
  // detail page re-validates it — a query parameter is reader-supplied input.
  const currentQuery = searchParams?.toString() ?? "";
  const backTo = currentQuery ? `${pathname}?${currentQuery}` : (pathname ?? "/connections");

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
    // the direction people actually want. The two elapsed-time columns start
    // high too: "longest waiting" is what an action list is for.
    const preferred =
      key === "score" || key === "strength" || key === "waiting" || key === "lastMessage"
        ? "desc"
        : "asc";
    const opposite = preferred === "asc" ? "desc" : "asc";
    const nextDirection = sort === key && direction === preferred ? opposite : preferred;
    pushParams({ sort: key, dir: nextDirection, page: "1" });
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);
  const columnCount = 4 + (markable ? 1 : 0) + (extraColumn ? 1 : 0);

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

      {toolbar}

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
                    {strengthSortable ? (
                      <SortButton
                        label="Relationship strength"
                        active={sort === "strength"}
                        direction={direction}
                        onClick={() => toggleSort("strength")}
                      />
                    ) : (
                      "Relationship strength"
                    )}
                  </th>
                  {markable ? (
                    <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                      Usefulness
                    </th>
                  ) : null}
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
                        {/* The name now opens the prospect page rather than
                            LinkedIn — everything this app knows about the
                            person lives there, and LinkedIn is one button on
                            it. A row with no `identityKey` at all has no page
                            to open, so it renders as plain text rather than a
                            broken link. The
                            profile link stays as its own affordance below, so
                            nothing that used to be one click away became two
                            for the people who only wanted LinkedIn. */}
                        <div className="ef-small" style={{ fontWeight: 600 }}>
                          {row.identityKey ? (
                            <Link
                              href={prospectHref(row.identityKey, backTo)}
                              style={{ color: "var(--blue-500)" }}
                            >
                              {displayName(row)}
                            </Link>
                          ) : (
                            displayName(row)
                          )}
                        </div>
                        {row.position ? <div className="ef-caption">{row.position}</div> : null}
                        {row.linkedinUrl ? (
                          <a
                            href={row.linkedinUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ef-caption"
                            style={{ color: "var(--text-secondary)" }}
                          >
                            LinkedIn
                            <span aria-hidden style={{ marginLeft: 3 }}>
                              ↗
                            </span>
                            <span className="sr-only">
                              {" "}
                              profile for {displayName(row)} (opens in a new tab)
                            </span>
                          </a>
                        ) : (
                          <div className="ef-caption" style={{ color: "var(--neutral-400)" }}>
                            No LinkedIn URL in export
                          </div>
                        )}
                      </td>
                      <td className="ef-small px-5 py-3">{row.company ?? "—"}</td>
                      <td className="px-5 py-3">
                        {renderStatus ? (
                          renderStatus(row)
                        ) : (
                          <span className={`ef-badge ${LEAD_STATUS_BADGE_CLASS[row.status]}`}>
                            {LEAD_STATUS_LABEL[row.status]}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3" style={{ minWidth: 180 }}>
                        <StrengthBar
                          score={row.relationshipScore}
                          factors={row.relationshipFactors}
                          basis={row.relationshipBasis ?? null}
                        />
                      </td>
                      {markable ? (
                        <td className="px-5 py-3">
                          {row.identityKey ? (
                            <ConnectionMarkButtons
                              // Remounts when the saved value changes (e.g. a
                              // router.refresh after a write), so the control's
                              // local optimistic state never outlives it.
                              key={`${row.identityKey}:${row.mark ?? "none"}`}
                              identityKey={row.identityKey}
                              personName={displayName(row)}
                              initialValue={row.mark ?? null}
                            />
                          ) : (
                            <span className="ef-caption" style={{ color: "var(--neutral-400)" }}>
                              —
                            </span>
                          )}
                        </td>
                      ) : null}
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

/**
 * Relationship strength out of 100, or an explicit "not yet scored" state.
 *
 * The provenance label under the bar is not decoration: `heuristic` means the
 * number came from the deterministic rules in
 * `src/lib/insights/relationship.ts` (message counts, recency, tenure) rather
 * than from a model reading the interaction history. Someone deciding who to
 * approach should know which they are looking at.
 */
function StrengthBar({
  score,
  factors,
  basis,
}: {
  score: number | null;
  factors?: string[];
  basis: "ai" | "heuristic" | null;
}) {
  if (score === null) {
    return (
      <span
        className="ef-caption"
        title="No messages or invitation note for this person in the import, so there is nothing to score a relationship from. Not the same as a weak relationship."
      >
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
      <div className="ef-caption mt-1 flex flex-wrap items-center gap-1">
        <span>{score} / 100</span>
        {basis === "heuristic" ? (
          <span
            style={{ color: "var(--neutral-400)" }}
            title="Calculated from message counts, recency and tenure — not an AI score. Either the AI pipeline has not reached this person yet, or no AI provider is configured."
          >
            · estimated
          </span>
        ) : basis === "ai" ? (
          <span style={{ color: "var(--neutral-400)" }} title="Scored by the AI pipeline from this person's interaction history.">
            · AI
          </span>
        ) : null}
      </div>
    </div>
  );
}
