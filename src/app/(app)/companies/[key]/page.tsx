import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { decodeCompanyKey } from "@/lib/companies/company-key";
import { fetchCompanyByKey } from "@/lib/insights/companies";
import {
  PROSPECT_PAGE_SIZE,
  fetchProspectPage,
  getLatestCompleteBatch,
  parseProspectSearchParams,
} from "@/lib/insights/prospects";
import { ProspectTable } from "@/components/prospect-table";

export const dynamic = "force-dynamic";

/**
 * ONE COMPANY.
 *
 * ADDRESSED BY THE NORMALISED COMPANY KEY, base64url encoded with the same
 * primitives as a person key — see `src/lib/companies/company-key.ts`. A raw
 * company name in the path would break on the slashes, dots and ampersands
 * that real company names are full of.
 *
 * THE PEOPLE TABLE IS THE SHARED `ProspectTable`, fed by the shared
 * `fetchProspectPage`, so this page behaves exactly like /connections —
 * server-side paging, the same sort columns, the same status badge, the same
 * relationship-strength column with its "not yet scored" state, the same
 * thumbs up/down, and names linking to the prospect page. The only difference
 * is the `companyIn` restriction.
 *
 * TENANCY: the batch comes from the signed-in user's own latest COMPLETE
 * import, never from the URL. A company key that names nothing in that batch
 * is a 404 — it names no account the reader has, and it must not be echoed
 * back as a page.
 */
export default async function CompanyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { key } = await params;
  const companyKey = decodeCompanyKey(key);
  if (!companyKey) notFound();

  const resolvedSearchParams = await searchParams;
  const tableParams = parseProspectSearchParams(resolvedSearchParams);

  const batch = await getLatestCompleteBatch(session.userId);
  if (!batch) notFound();

  const company = await fetchCompanyByKey({
    importBatchId: batch.id,
    organizationId: session.organizationId,
    companyKey,
  });
  if (!company) notFound();

  const { rows, total, page } = await fetchProspectPage({
    userId: session.userId,
    importBatchId: batch.id,
    page: tableParams.page,
    sort: tableParams.sort,
    direction: tableParams.direction,
    query: tableParams.query,
    // The group's raw spellings, not the normalised key: `Connection.company`
    // stores what the export said, so an exact IN list is what selects the
    // people and it keeps this on the shared paging path.
    companyIn: company.spellingList,
  });

  const backHref = resolveBackLink(resolvedSearchParams);
  const neverMessaged = company.connections - company.messaged;

  return (
    <div>
      <Link href={backHref} className="ef-small" style={{ color: "var(--blue-500)" }}>
        ← All companies
      </Link>

      <p className="ef-eyebrow mb-2 mt-4">Account</p>
      <h1 className="ef-page mb-2">{company.displayName}</h1>
      <p className="ef-lead mb-6" style={{ maxWidth: 680 }}>
        {company.connections === 1
          ? "One person in your network works here, according to your latest import."
          : `${company.connections.toLocaleString()} people in your network work here, according to your latest import.`}
      </p>

      <div
        className="mb-6 grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}
      >
        <Stat label="Connections" value={company.connections.toLocaleString()} />
        <Stat
          label="Messaged"
          value={company.messaged.toLocaleString()}
          note={`${neverMessaged.toLocaleString()} never messaged`}
        />
        <Stat
          label="Strongest relationship"
          value={
            company.bestRelationshipScore === null
              ? "Not yet scored"
              : `${company.bestRelationshipScore} / 100`
          }
          note={
            company.bestRelationshipScore === null
              ? "No relationship score for anyone here yet"
              : `best of ${company.scoredConnections.toLocaleString()} scored`
          }
        />
        <Stat label="ICP matches" value={company.icpMatches.toLocaleString()} />
      </div>

      {/* The grouping evidence. Shown whenever more than one raw spelling was
          folded, because that is exactly where the normalisation made a
          judgement the reader might disagree with. */}
      {company.spellings > 1 ? (
        <div className="ef-card mb-6" style={{ maxWidth: 820 }}>
          <p className="ef-small" style={{ fontWeight: 600 }}>
            {company.spellings} spellings grouped as one company
          </p>
          <p className="ef-small mt-1" style={{ color: "var(--text-secondary)" }}>
            These are the exact spellings folded together here:
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {company.spellingList.map((spelling) => (
              <li key={spelling} className="ef-badge ef-badge-neutral">
                {spelling}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ProspectTable
        rows={rows}
        total={total}
        page={page}
        pageSize={PROSPECT_PAGE_SIZE}
        sort={tableParams.sort}
        direction={tableParams.direction}
        strengthSortable
        markable
        query={tableParams.query}
        searchPlaceholder="Search people at this company…"
        emptyState={
          <div className="ef-card">
            <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
              No one at this company matches &ldquo;{tableParams.query}&rdquo;.
            </p>
          </div>
        }
      />
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="ef-card">
      <p className="ef-caption">{label}</p>
      <p className="ef-subhead mt-1">{value}</p>
      {note ? (
        <p className="ef-caption mt-1" style={{ color: "var(--text-secondary)" }}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Reader-supplied `?from=`, validated to a path inside this app: it must start
 * with a single `/`, which rules out absolute URLs and protocol-relative
 * `//evil.example`. Same rule as the prospect detail page — a back link that
 * accepted anything would be an open redirect wearing a breadcrumb's clothes.
 */
function resolveBackLink(params: Record<string, string | string[] | undefined>): string {
  const raw = Array.isArray(params.from) ? params.from[0] : params.from;
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/companies";
  return raw;
}
