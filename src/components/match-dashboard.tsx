import Link from "next/link";
import type { MatchType } from "@prisma/client";
import { ProspectTable } from "@/components/prospect-table";
import { DefinitionFilter } from "@/components/definition-filter";
import {
  MATCH_PAGE_SIZE,
  fetchMatchPage,
  listDefinitions,
  parseMatchSearchParams,
} from "@/lib/insights/matches";
import { getLatestCompleteBatch } from "@/lib/insights/prospects";

/**
 * The all-ICPs and all-channel-partners dashboards are the same page with a
 * different `matchType`, so they share this server component rather than
 * being copy-pasted. It renders the shared `ProspectTable` with an extra
 * column naming the definition that was matched and the score behind it.
 */
export async function MatchDashboard({
  matchType,
  userId,
  organizationId,
  isAdmin,
  searchParams,
  copy,
}: {
  matchType: MatchType;
  userId: string;
  organizationId: string;
  isAdmin: boolean;
  searchParams: Record<string, string | string[] | undefined>;
  copy: {
    eyebrow: string;
    title: string;
    lead: string;
    /** e.g. "ICP" — used in the extra column header and the filter label. */
    noun: string;
    adminHref: string;
    adminLabel: string;
  };
}) {
  const params = parseMatchSearchParams(searchParams);
  const [batch, definitions] = await Promise.all([
    getLatestCompleteBatch(userId),
    listDefinitions(matchType, organizationId),
  ]);

  const header = (
    <>
      <p className="ef-eyebrow mb-2">{copy.eyebrow}</p>
      <h1 className="ef-page mb-2">{copy.title}</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 680 }}>
        {copy.lead}
      </p>
    </>
  );

  // 1. Nothing imported: there are no connections to match against.
  if (!batch) {
    return (
      <div>
        {header}
        <InfoCard badge="Get started" title="No imports yet">
          <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
            Matching runs over your most recent LinkedIn export. Upload one and
            your {copy.noun.toLowerCase()} matches appear here automatically.
          </p>
          <Link href="/imports" className="ef-btn ef-btn-primary mt-3">
            Upload your export
          </Link>
        </InfoCard>
      </div>
    );
  }

  // 2. Nothing to match against: the org has no definitions yet.
  if (definitions.length === 0) {
    return (
      <div>
        {header}
        <InfoCard badge="Nothing defined" title={`No ${copy.noun.toLowerCase()}s defined yet`}>
          <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
            {isAdmin
              ? `Your organization has not defined any ${copy.noun.toLowerCase()}s, so there is nothing to score connections against. Define one and every member's connections are scored automatically.`
              : `Your organization has not defined any ${copy.noun.toLowerCase()}s yet. An admin needs to add one before matches can appear here.`}
          </p>
          {isAdmin ? (
            <Link href={copy.adminHref} className="ef-btn ef-btn-primary mt-3">
              {copy.adminLabel}
            </Link>
          ) : null}
        </InfoCard>
      </div>
    );
  }

  const { rows, total, page } = await fetchMatchPage({
    matchType,
    importBatchId: batch.id,
    organizationId,
    page: params.page,
    sort: params.sort,
    direction: params.direction,
    query: params.query,
    definitionId: params.definitionId,
  });

  const filtered = params.definitionId !== "" || params.query !== "";

  return (
    <div>
      {header}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <DefinitionFilter
          label={`Filter by ${copy.noun.toLowerCase()}`}
          allLabel={`All ${copy.noun.toLowerCase()}s`}
          definitions={definitions}
          selectedId={params.definitionId}
        />
        <p className="ef-caption">
          Snapshot from your import on{" "}
          {(batch.completedAt ?? batch.createdAt).toLocaleDateString()}.
        </p>
      </div>

      <ProspectTable
        rows={rows.map((row) => ({
          ...row,
          extra: (
            <div title={row.rationale ?? undefined}>
              <div className="ef-small" style={{ fontWeight: 600 }}>
                {row.definitionName}
              </div>
              <div className="ef-caption">Match score {row.matchScore} / 100</div>
              {row.rationale ? (
                <div className="ef-caption" style={{ color: "var(--text-secondary)", maxWidth: 320 }}>
                  {row.rationale}
                </div>
              ) : null}
            </div>
          ),
        }))}
        total={total}
        page={page}
        pageSize={MATCH_PAGE_SIZE}
        sort={params.sort}
        direction={params.direction}
        query={params.query}
        extraColumn={{ header: copy.noun, sortKey: "score" }}
        emptyState={
          <InfoCard
            badge={filtered ? "No results" : "Nothing scored yet"}
            title={filtered ? "Nothing matches this filter" : "No matches yet"}
          >
            <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
              {filtered
                ? "Try clearing the search box or picking a different definition."
                : `Scoring runs in the background after every import and whenever an admin changes a ${copy.noun.toLowerCase()}. If you have just uploaded or just saved a definition, give it a minute and refresh. If it stays empty, none of your connections cleared the match threshold — widening the definition's positions or industry usually fixes that.`}
            </p>
          </InfoCard>
        }
      />
    </div>
  );
}

function InfoCard({
  badge,
  title,
  children,
}: {
  badge: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ef-card ef-rise flex flex-col items-start gap-2" style={{ maxWidth: 620 }}>
      <span className="ef-badge ef-badge-info">{badge}</span>
      <p className="ef-subhead">{title}</p>
      {children}
    </div>
  );
}
