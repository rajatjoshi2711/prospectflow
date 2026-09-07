import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { CountryBarChart, type CountryCount } from "@/components/country-bar-chart";
import { getLatestCompleteBatch } from "@/lib/insights/prospects";

const REMINDER_AFTER_DAYS = 15;
const JOB_CHANGE_PREVIEW_LIMIT = 8;

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const [user, batch, importCount] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.userId },
      select: { lastImportAt: true },
    }),
    getLatestCompleteBatch(session.userId),
    prisma.importBatch.count({ where: { userId: session.userId, status: "COMPLETE" } }),
  ]);

  const [connectionCount, countryGroups, jobChanges] = await Promise.all([
    batch ? prisma.connection.count({ where: { importBatchId: batch.id } }) : Promise.resolve(0),
    batch
      ? prisma.connection.groupBy({
          by: ["country"],
          where: { importBatchId: batch.id, country: { not: null } },
          _count: { country: true },
          orderBy: { _count: { country: "desc" } },
          take: 10,
        })
      : Promise.resolve([]),
    // JobChangeEvent has no userId column; scope it through the batch it was
    // detected on, which belongs to this user.
    prisma.jobChangeEvent.findMany({
      where: { currentBatch: { userId: session.userId } },
      orderBy: { detectedAt: "desc" },
      take: JOB_CHANGE_PREVIEW_LIMIT,
      select: {
        id: true,
        identityKey: true,
        previousTitle: true,
        previousCompany: true,
        newTitle: true,
        newCompany: true,
        detectedAt: true,
      },
    }),
  ]);

  const jobChangeTotal = await prisma.jobChangeEvent.count({
    where: { currentBatch: { userId: session.userId } },
  });

  // Resolve identityKeys to names where a matching connection exists in this
  // user's data. Some will not resolve — Phase 2 derives Position.identityKey
  // from a name hash while Connection.identityKey prefers the LinkedIn URL, so
  // the two key spaces only overlap for URL-less rows. Those fall back to
  // showing the company/title change on its own.
  const namesByIdentity = new Map<string, string>();
  if (jobChanges.length > 0) {
    const matches = await prisma.connection.findMany({
      where: {
        identityKey: { in: jobChanges.map((event) => event.identityKey) },
        importBatch: { userId: session.userId },
      },
      distinct: ["identityKey"],
      select: { identityKey: true, firstName: true, lastName: true, linkedinUrl: true },
    });
    for (const match of matches) {
      const name = [match.firstName, match.lastName].filter(Boolean).join(" ").trim();
      if (name) namesByIdentity.set(match.identityKey, name);
    }
  }

  const countries: CountryCount[] = countryGroups.flatMap((group) =>
    group.country ? [{ country: group.country, count: group._count.country }] : [],
  );

  const daysSinceImport = daysSince(user?.lastImportAt ?? null);
  const needsReminder = daysSinceImport === null || daysSinceImport >= REMINDER_AFTER_DAYS;

  return (
    <div>
      <p className="ef-eyebrow mb-2">Dashboard</p>
      <h1 className="ef-page mb-2">Welcome back, {session.name.split(" ")[0]}</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 680 }}>
        Your personal view of the network you have imported: who moved jobs,
        where your connections sit, and when to refresh your data.
      </p>

      {needsReminder ? (
        <div
          className="ef-card ef-rise mb-8 flex flex-wrap items-center justify-between gap-4"
          style={{ background: "var(--warning-soft)", borderColor: "#f0dcae" }}
        >
          <div>
            <p className="ef-subhead mb-1">
              {daysSinceImport === null
                ? "Upload your first LinkedIn export"
                : "Time for a fresh LinkedIn export"}
            </p>
            <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
              {daysSinceImport === null
                ? "ProspectFlow needs your LinkedIn data export before it can show your network, job changes, or prospects."
                : `Your last import was ${daysSinceImport} days ago. Re-upload every ${REMINDER_AFTER_DAYS} days so job changes stay current.`}
            </p>
          </div>
          <Link href="/imports" className="ef-btn ef-btn-primary">
            {daysSinceImport === null ? "Upload export" : "Upload a new export"}
          </Link>
        </div>
      ) : null}

      <div className="mb-8 grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <StatCard label="Connections" value={connectionCount.toLocaleString()} />
        <StatCard
          label="Last import"
          value={
            user?.lastImportAt
              ? user.lastImportAt.toLocaleDateString()
              : "Never"
          }
        />
        <StatCard label="Completed imports" value={importCount.toLocaleString()} />
        <StatCard label="Job changes detected" value={jobChangeTotal.toLocaleString()} />
      </div>

      <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
        <section className="ef-card">
          <p className="ef-subhead mb-1">Top 10 countries by connections</p>
          <p className="ef-caption mb-4">
            Where the people in your network are based.
          </p>
          {countries.length > 0 ? (
            <CountryBarChart data={countries} />
          ) : (
            <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
              {batch
                ? "LinkedIn's Connections.csv does not include a country column, so no location is available for your connections yet. This chart fills in automatically once country data is enriched onto connections."
                : "Upload a LinkedIn export to see where your network is based."}
            </p>
          )}
        </section>

        <section className="ef-card">
          <div className="mb-1 flex items-center justify-between gap-3">
            <p className="ef-subhead">Job change alerts</p>
            {jobChangeTotal > jobChanges.length ? (
              <Link href="/imports" className="ef-btn ef-btn-text">
                See all {jobChangeTotal.toLocaleString()}
              </Link>
            ) : null}
          </div>
          <p className="ef-caption mb-4">
            Detected by comparing your two most recent imports.
          </p>
          {jobChanges.length === 0 ? (
            <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
              {importCount < 2
                ? "Job changes appear once you have uploaded at least two exports — ProspectFlow compares the two most recent."
                : "No job changes since your previous import."}
            </p>
          ) : (
            <ul className="flex flex-col gap-3" style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {jobChanges.map((event) => (
                <li
                  key={event.id}
                  className="border-t pt-3 first:border-t-0 first:pt-0"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <p className="ef-small" style={{ fontWeight: 600 }}>
                    {namesByIdentity.get(event.identityKey) ?? "A connection"}
                  </p>
                  <p className="ef-caption">
                    {formatRole(event.previousTitle, event.previousCompany)}
                    <span aria-hidden style={{ margin: "0 6px" }}>
                      →
                    </span>
                    <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                      {formatRole(event.newTitle, event.newCompany)}
                    </span>
                  </p>
                  <p className="ef-caption" style={{ color: "var(--neutral-400)" }}>
                    {event.detectedAt.toLocaleDateString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <PhaseFourSlot
          title="Top 5 ICP fits"
          description="Your connections that best match your organization's Ideal Customer Profiles, scored and explained."
        />
        <PhaseFourSlot
          title="Top 5 channel partners"
          description="Your connections that best match your organization's channel-partner criteria."
        />
      </div>
    </div>
  );
}

/** Whole days between `date` and now, or null when there is no date. */
function daysSince(date: Date | null): number | null {
  if (!date) return null;
  return Math.floor((new Date().getTime() - date.getTime()) / 86_400_000);
}

function formatRole(title: string | null, company: string | null) {
  const parts = [title, company].filter(Boolean);
  return parts.length > 0 ? parts.join(" at ") : "Unknown role";
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="ef-card">
      <p className="ef-caption mb-1">{label}</p>
      <p style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 28, lineHeight: 1.1 }}>
        {value}
      </p>
    </div>
  );
}

/**
 * Placeholder for a Phase 4 box. Kept visually consistent with the live cards
 * so the dashboard layout is final — Phase 4 only has to swap the body.
 */
function PhaseFourSlot({ title, description }: { title: string; description: string }) {
  return (
    <section className="ef-card" style={{ background: "var(--bg-subtle)" }}>
      <div className="mb-1 flex items-center justify-between gap-3">
        <p className="ef-subhead">{title}</p>
        <span className="ef-badge ef-badge-neutral">Next phase</span>
      </div>
      <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
        {description}
      </p>
      <ul className="mt-4 flex flex-col gap-2" style={{ margin: 0, padding: 0, listStyle: "none" }} aria-hidden>
        {[0, 1, 2].map((index) => (
          <li
            key={index}
            style={{ height: 12, borderRadius: 6, background: "var(--neutral-100)", width: `${90 - index * 18}%` }}
          />
        ))}
      </ul>
    </section>
  );
}
