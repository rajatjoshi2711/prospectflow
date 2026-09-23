import type { ReactNode } from "react";
import Link from "next/link";
import { ProspectTable, type ProspectSortKey } from "@/components/prospect-table";
import {
  fetchProspectPage,
  getLatestCompleteBatch,
  parseProspectSearchParams,
} from "@/lib/insights/prospects";
import { ACTION_PAGE_SIZE, type ActionPage } from "@/lib/insights/prospecting-actions";

/**
 * The full page behind one "do this next" dashboard card.
 *
 * The three pages are the same page with a different population, so they share
 * this component rather than being copy-pasted — the same reason
 * `MatchDashboard` exists for the two match dashboards.
 *
 * WHAT IS SHARED WITH /connections, AND WHY
 * -----------------------------------------
 * The table is the same `ProspectTable`, and the rows come from the same
 * `fetchProspectPage`. So status, the Usefulness marks, relationship strength
 * and provenance, the LinkedIn link and the link to the prospect page are all
 * resolved by one code path — an action page cannot describe a person
 * differently from the connections list.
 *
 * What is NOT shared is which people are on the page and in what order. The
 * caller's `load` runs the list's own definition in SQL and returns just this
 * page's connection ids, already ordered and counted; `fetchProspectPage` takes
 * them as `population`. That definition lives once, in
 * `prospecting-actions.ts`, and the dashboard card reads the same fragment.
 */
export async function ActionListPage({
  userId,
  searchParams,
  sortKeys,
  defaultSort,
  extraColumn,
  renderExtra,
  load,
  copy,
}: {
  userId: string;
  searchParams: Record<string, string | string[] | undefined>;
  /** What `?sort=` may say here. A key this page cannot execute is rejected. */
  sortKeys: ProspectSortKey[];
  /** The list's own dimension — the ordering that IS the point of the list. */
  defaultSort: ProspectSortKey;
  extraColumn: { header: string; sortKey: ProspectSortKey };
  /** The extra cell for one row, from the dimension the population query returned. */
  renderExtra: (value: { at: Date; relationshipScore: number | null }) => ReactNode;
  load: (args: {
    /** The viewer, so the population can order by their own Usefulness marks. */
    userId: string;
    importBatchId: string;
    page: number;
    sort: ProspectSortKey;
    direction: "asc" | "desc";
    query: string;
  }) => Promise<ActionPage>;
  copy: {
    title: string;
    lead: string;
    /** Shown when the list is empty and nothing is wrong — the good outcome. */
    nothingWaiting: ReactNode;
    /** Shown when the list is empty only because a search matched nothing. */
    noSearchResults?: (query: string) => ReactNode;
    /**
     * Overrides the empty state when the list is empty for a reason other than
     * there being nothing to do — e.g. relationship scoring has not run yet.
     */
    blocked?: ReactNode;
    /** Rendered under the header, e.g. the direction-unknown caveat. */
    footnote?: (result: ActionPage) => ReactNode;
  };
}) {
  const params = parseProspectSearchParams(searchParams, {
    sortKeys,
    defaultSort,
    // The list's own dimension reads "most first": longest waiting, most
    // recently connected, longest dormant. That ordering is the point of the
    // list, so it is what a reader gets before touching a header.
    defaultDirection: "desc",
  });
  const batch = await getLatestCompleteBatch(userId);

  const header = (
    <>
      {/* Reached from the dashboard and nowhere else — these three pages are
          deliberately not in the sidebar — so the way back is to the dashboard.
          Same control as the campaign detail page. */}
      <Link
        href="/dashboard"
        className="ef-small mb-3 inline-flex items-center gap-1"
        style={{ color: "var(--text-secondary)" }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Back to dashboard
      </Link>
      <p className="ef-eyebrow mb-2">Do this next</p>
      <h1 className="ef-page mb-2">{copy.title}</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 680 }}>
        {copy.lead}
      </p>
    </>
  );

  if (!batch) {
    return (
      <div>
        {header}
        <div className="ef-card ef-rise flex flex-col items-start gap-3" style={{ maxWidth: 520 }}>
          <span className="ef-badge ef-badge-info">Get started</span>
          <p className="ef-subhead">No imports yet</p>
          <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
            This list is built from your most recent completed LinkedIn export.
            Upload one and it fills itself in.
          </p>
          <Link href="/imports" className="ef-btn ef-btn-primary">
            Upload your first LinkedIn export
          </Link>
        </div>
      </div>
    );
  }

  const result = await load({
    userId,
    importBatchId: batch.id,
    page: params.page,
    sort: params.sort,
    direction: params.direction,
    query: params.query,
  });

  const { rows, total, page } = await fetchProspectPage({
    userId,
    importBatchId: batch.id,
    page: result.page,
    sort: params.sort,
    direction: params.direction,
    query: params.query,
    population: { ids: result.ids, total: result.total, page: result.page },
  });

  const footnote = copy.footnote?.(result);

  return (
    <div>
      {header}
      <p className="ef-caption mb-4">
        Snapshot from your import on{" "}
        {(batch.completedAt ?? batch.createdAt).toLocaleDateString()}.
      </p>
      {footnote ? (
        <p className="ef-caption mb-4" style={{ maxWidth: 680, color: "var(--text-secondary)" }}>
          {footnote}
        </p>
      ) : null}

      <ProspectTable
        rows={rows.map((row) => {
          const value = result.extra.get(row.id);
          return { ...row, extra: value ? renderExtra(value) : null };
        })}
        total={total}
        page={page}
        pageSize={ACTION_PAGE_SIZE}
        sort={params.sort}
        direction={params.direction}
        query={params.query}
        strengthSortable
        markable
        extraColumn={extraColumn}
        emptyState={
          <div className="ef-card" style={{ maxWidth: 620 }}>
            {/* Three distinct empty states. An empty action list is normally
                the GOOD outcome — there is nothing waiting on you — so it is
                never dressed up as an error, and never as a zero standing in
                for data the app does not have. */}
            {copy.blocked ? (
              <>
                <span className="ef-badge ef-badge-info">Not yet known</span>
                <p className="ef-small mt-3" style={{ color: "var(--text-secondary)" }}>
                  {copy.blocked}
                </p>
              </>
            ) : params.query ? (
              <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
                {copy.noSearchResults?.(params.query) ?? (
                  <>
                    Nobody on this list matches &ldquo;{params.query}&rdquo;. Try a different
                    name or company.
                  </>
                )}
              </p>
            ) : (
              <>
                <span className="ef-badge ef-badge-success">Nothing waiting</span>
                <p className="ef-small mt-3" style={{ color: "var(--text-secondary)" }}>
                  {copy.nothingWaiting}
                </p>
              </>
            )}
          </div>
        }
      />
    </div>
  );
}
