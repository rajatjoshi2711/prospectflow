import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { CompanyTable } from "@/components/company-table";
import {
  COMPANY_PAGE_SIZE,
  fetchCompanyPage,
  parseCompanySearchParams,
} from "@/lib/insights/companies";
import { getLatestCompleteBatch } from "@/lib/insights/prospects";

export const dynamic = "force-dynamic";

/**
 * ACCOUNT MAPPING.
 *
 * Every dashboard before this one is person-shaped. This one is
 * account-shaped: three people at one target company is one opportunity, and
 * the only way to see that is to roll the network up by employer.
 *
 * GROUPING IS APPROXIMATE
 * -----------------------
 * `Connection.company` is free text off a CSV. The grouping is a best effort
 * (see `src/lib/companies/normalize.ts`) and it is wrong in both directions at
 * the margins — it will not know that "IBM" and "International Business
 * Machines" are one employer, and it cannot tell two unrelated firms with the
 * same name apart. The explanatory copy that used to say so on the page was
 * removed at the user's request; the evidence remains, in that every grouped
 * row shows how many raw spellings it folded and the company page lists them.
 *
 * CONNECTIONS WITH NO COMPANY are EXCLUDED from the table. `fetchCompanyPage`
 * still returns the count, but nothing renders it now. The alternative — a
 * bucket called "Unknown" — puts a row in a list of employers that is not an
 * employer, and it would sort and rank alongside real accounts as if it were
 * one.
 */
export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const params = parseCompanySearchParams(await searchParams);
  const [batch, icpCount] = await Promise.all([
    getLatestCompleteBatch(session.userId),
    // One indexed count on `ICP(organizationId)`. Without it the table cannot
    // tell "nobody here matches an ICP" from "this org has no ICPs", and would
    // print a zero for both.
    prisma.iCP.count({ where: { organizationId: session.organizationId } }),
  ]);

  const header = (
    <>
      <p className="ef-eyebrow mb-2">Network</p>
      {/* Carries the header's bottom spacing itself: other pages get it from
          the lead paragraph under the title, and this page has none. */}
      <h1 className="ef-page mb-6">Companies</h1>
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
            Account mapping reads the company on each connection&rsquo;s profile in
            your most recent LinkedIn export. Upload one and your accounts show
            up here.
          </p>
          <Link href="/imports" className="ef-btn ef-btn-primary">
            Upload your first LinkedIn export
          </Link>
        </div>
      </div>
    );
  }

  const { rows, total, page } = await fetchCompanyPage({
    importBatchId: batch.id,
    organizationId: session.organizationId,
    page: params.page,
    sort: params.sort,
    direction: params.direction,
    query: params.query,
  });

  return (
    <div>
      {header}

      <CompanyTable
        rows={rows}
        total={total}
        page={page}
        pageSize={COMPANY_PAGE_SIZE}
        sort={params.sort}
        direction={params.direction}
        query={params.query}
        hasIcpDefinitions={icpCount > 0}
      />
    </div>
  );
}
