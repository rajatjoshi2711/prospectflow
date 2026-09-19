"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { companyHref } from "@/lib/companies/company-key";
import type { CompanyRow, CompanySortKey } from "@/lib/insights/companies";

/**
 * The account-mapping table.
 *
 * A sibling of `ProspectTable` rather than a fork of it: the columns are
 * company-level aggregates, not person fields, so nothing of that component's
 * row shape applies. What IS shared is the behaviour — paging, sorting and
 * search are SERVER-side and this component only reads and writes the URL
 * query string, so the page stays server-rendered and every view is a
 * shareable link.
 *
 * HONESTY IN THIS TABLE
 * ---------------------
 * - "Relationship" shows the STRONGEST relationship at the company and says so.
 *   When nobody there has been scored it reads "Not yet scored", never 0.
 * - "ICP matches" shows an em dash, not a zero, when the org has defined no
 *   ICPs at all — a zero would read as "nobody here fits", which is a finding
 *   we have not made.
 * - Any company whose group folded together more than one raw spelling carries
 *   a visible "n spellings" note, so the reader can see where the grouping
 *   made a judgement call.
 */
export function CompanyTable({
  rows,
  total,
  page,
  pageSize,
  sort,
  direction,
  query,
  hasIcpDefinitions,
}: {
  rows: CompanyRow[];
  total: number;
  page: number;
  pageSize: number;
  sort: CompanySortKey;
  direction: "asc" | "desc";
  query: string;
  /**
   * Whether the org has any ICP defined. Without one, every ICP count is
   * necessarily 0 and printing that number would be a fabricated finding.
   */
  hasIcpDefinitions: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const currentQuery = searchParams?.toString() ?? "";
  const backTo = currentQuery ? `${pathname}?${currentQuery}` : (pathname ?? "/companies");

  function pushParams(updates: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    const qs = next.toString();
    router.push(qs ? `?${qs}` : "?", { scroll: false });
  }

  function toggleSort(key: CompanySortKey) {
    // Counts read best biggest-first, names A-Z.
    const preferred = key === "name" ? "asc" : "desc";
    const opposite = preferred === "asc" ? "desc" : "asc";
    const nextDirection = sort === key && direction === preferred ? opposite : preferred;
    pushParams({ sort: key, dir: nextDirection, page: "1" });
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get("q");
          pushParams({ q: (typeof value === "string" ? value.trim() : "") || null, page: "1" });
        }}
      >
        {/* Uncontrolled + keyed on `query` so a URL change resets the field
            without a state-syncing effect. Same approach as ProspectTable. */}
        <input
          key={query}
          name="q"
          className="ef-input"
          style={{ maxWidth: 360 }}
          defaultValue={query}
          placeholder="Search companies…"
          aria-label="Search companies"
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

      {total === 0 ? (
        <div className="ef-card">
          <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
            {query
              ? `No companies match “${query}”. Try a shorter term — the search also looks at the grouped name, so “Acme” finds “Acme, Inc.”.`
              : "No connection in this import has a company on their profile, so there is nothing to map yet."}
          </p>
        </div>
      ) : (
        <>
          <div className="ef-card overflow-x-auto p-0">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr style={{ background: "var(--bg-subtle)" }}>
                  <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                    <SortButton
                      label="Company"
                      active={sort === "name"}
                      direction={direction}
                      onClick={() => toggleSort("name")}
                    />
                  </th>
                  <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                    <SortButton
                      label="Connections"
                      active={sort === "connections"}
                      direction={direction}
                      onClick={() => toggleSort("connections")}
                    />
                  </th>
                  <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                    <SortButton
                      label="Messaged"
                      active={sort === "messaged"}
                      direction={direction}
                      onClick={() => toggleSort("messaged")}
                    />
                  </th>
                  <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                    <SortButton
                      label="Strongest relationship"
                      active={sort === "strength"}
                      direction={direction}
                      onClick={() => toggleSort("strength")}
                    />
                  </th>
                  <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                    <SortButton
                      label="ICP matches"
                      active={sort === "icp"}
                      direction={direction}
                      onClick={() => toggleSort("icp")}
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                    <td className="px-5 py-3">
                      <div className="ef-small" style={{ fontWeight: 600 }}>
                        <Link href={companyHref(row.key, backTo)} style={{ color: "var(--blue-500)" }}>
                          {row.displayName}
                        </Link>
                      </div>
                      {row.spellings > 1 ? (
                        <div
                          className="ef-caption"
                          style={{ color: "var(--text-secondary)" }}
                          title={`${row.spellings} different spellings of this company name in the export were grouped together. Open the company to see them.`}
                        >
                          {row.spellings} spellings grouped
                        </div>
                      ) : null}
                    </td>
                    <td className="ef-small px-5 py-3">{row.connections.toLocaleString()}</td>
                    <td className="px-5 py-3">
                      <div className="ef-small">{row.messaged.toLocaleString()}</div>
                      <div className="ef-caption" style={{ color: "var(--text-secondary)" }}>
                        {row.connections - row.messaged} never messaged
                      </div>
                    </td>
                    <td className="px-5 py-3" style={{ minWidth: 170 }}>
                      {row.bestRelationshipScore === null ? (
                        <span
                          className="ef-caption"
                          title="Nobody at this company has a relationship score yet — either the scoring run has not reached this import, or there is no message history with any of them. Not the same as a weak relationship."
                        >
                          Not yet scored
                        </span>
                      ) : (
                        <>
                          <div className="ef-small">{row.bestRelationshipScore} / 100</div>
                          <div className="ef-caption" style={{ color: "var(--text-secondary)" }}>
                            best of {row.scoredConnections.toLocaleString()} scored
                          </div>
                        </>
                      )}
                    </td>
                    <td className="ef-small px-5 py-3">
                      {hasIcpDefinitions ? (
                        row.icpMatches.toLocaleString()
                      ) : (
                        <span
                          className="ef-caption"
                          title="Your organization has not defined any ICPs, so nothing has been scored against one."
                        >
                          No ICPs defined
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
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
      style={{
        fontWeight: 700,
        color: active ? "var(--blue-500)" : "var(--text-primary)",
        cursor: "pointer",
      }}
      aria-label={`Sort by ${label}`}
    >
      {label}
      <span aria-hidden style={{ opacity: active ? 1 : 0.35 }}>
        {active && direction === "desc" ? "▾" : "▴"}
      </span>
    </button>
  );
}
