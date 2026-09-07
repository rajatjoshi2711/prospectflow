import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { ProspectTable } from "@/components/prospect-table";
import {
  PROSPECT_PAGE_SIZE,
  fetchProspectPage,
  getLatestCompleteBatch,
  parseProspectSearchParams,
} from "@/lib/insights/prospects";

export default async function ConnectionsDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const params = parseProspectSearchParams(await searchParams);
  const batch = await getLatestCompleteBatch(session.userId);

  const header = (
    <>
      <p className="ef-eyebrow mb-2">Phase 3 — core dashboards</p>
      <h1 className="ef-page mb-2">All connections</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 680 }}>
        Every connection from your most recent completed import, with outreach
        status and relationship strength.
      </p>
    </>
  );

  if (!batch) {
    return (
      <div>
        {header}
        <NoImportsCard />
      </div>
    );
  }

  const { rows, total, page } = await fetchProspectPage({
    importBatchId: batch.id,
    page: params.page,
    sort: params.sort,
    direction: params.direction,
    query: params.query,
  });

  return (
    <div>
      {header}
      <p className="ef-caption mb-4">
        Snapshot from your import on{" "}
        {(batch.completedAt ?? batch.createdAt).toLocaleDateString()}.
      </p>
      <ProspectTable
        rows={rows}
        total={total}
        page={page}
        pageSize={PROSPECT_PAGE_SIZE}
        sort={params.sort}
        direction={params.direction}
        query={params.query}
        emptyState={
          params.query ? (
            <div className="ef-card">
              <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
                No connections match &ldquo;{params.query}&rdquo;. Try a different name or
                company.
              </p>
            </div>
          ) : (
            <NoImportsCard
              title="No connections in this import"
              body="Your latest import completed but contained no Connections.csv rows. Upload a full LinkedIn export to populate this view."
            />
          )
        }
      />
    </div>
  );
}

function NoImportsCard({
  title = "No imports yet",
  body = "Upload your LinkedIn data export and your whole network shows up here, with outreach status and relationship strength for every connection.",
}: {
  title?: string;
  body?: string;
}) {
  return (
    <div className="ef-card ef-rise flex flex-col items-start gap-3" style={{ maxWidth: 520 }}>
      <span className="ef-badge ef-badge-info">Get started</span>
      <p className="ef-subhead">{title}</p>
      <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
        {body}
      </p>
      <Link href="/imports" className="ef-btn ef-btn-primary">
        Upload your first LinkedIn export
      </Link>
    </div>
  );
}
