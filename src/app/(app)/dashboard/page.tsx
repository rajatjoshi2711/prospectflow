import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { CountryBarChart, type CountryCount } from "@/components/country-bar-chart";
import { getLatestCompleteBatch } from "@/lib/insights/prospects";
import { fetchTopMatchesByCompany, type CompanyGroup } from "@/lib/insights/matches";

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
        personName: true,
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

  // Job changes are now detected by diffing Connection rows, so `personName`
  // is captured at detection time and no lookup is normally needed. The lookup
  // below only backfills the name for legacy events written by the old
  // Position-based diff (which left `personName` null); those keys came from a
  // different key space and mostly will not resolve, in which case the alert
  // renders the role change on its own.
  const namesByIdentity = new Map<string, string>();
  const unresolved = jobChanges.filter((event) => !event.personName);
  if (unresolved.length > 0) {
    const matches = await prisma.connection.findMany({
      where: {
        identityKey: { in: unresolved.map((event) => event.identityKey) },
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

  // Phase 4: the two match boxes. Counting definitions separately from matches
  // lets the cards tell "nobody has defined an ICP" apart from "defined, but
  // nothing scored yet" — two very different things to act on.
  const [icpCount, channelPartnerCount, topIcpGroups, topPartnerGroups] = await Promise.all([
    prisma.iCP.count({ where: { organizationId: session.organizationId } }),
    prisma.channelPartner.count({ where: { organizationId: session.organizationId } }),
    batch
      ? fetchTopMatchesByCompany({
          matchType: "ICP",
          importBatchId: batch.id,
          organizationId: session.organizationId,
        })
      : Promise.resolve([]),
    batch
      ? fetchTopMatchesByCompany({
          matchType: "CHANNEL_PARTNER",
          importBatchId: batch.id,
          organizationId: session.organizationId,
        })
      : Promise.resolve([]),
  ]);

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
                    {event.personName ?? namesByIdentity.get(event.identityKey) ?? "A connection"}
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

        <TopMatchesCard
          title="Top 5 ICP fits"
          href="/icps"
          groups={topIcpGroups}
          hasDefinitions={icpCount > 0}
          hasImport={batch !== null}
          isAdmin={session.role === "ADMIN"}
          adminHref="/admin/icps"
          noun="ICP"
        />
        <TopMatchesCard
          title="Top 5 channel partners"
          href="/channel-partners"
          groups={topPartnerGroups}
          hasDefinitions={channelPartnerCount > 0}
          hasImport={batch !== null}
          isAdmin={session.role === "ADMIN"}
          adminHref="/admin/channel-partners"
          noun="channel partner"
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
 * Top five matches, GROUPED BY COMPANY.
 *
 * Three matched people at one target account is one opportunity, not three,
 * so the card lists five companies and names everyone matched inside each.
 * Every empty case is distinguished, because "no ICPs defined", "no import"
 * and "defined but nothing scored yet" each need a different next step.
 */
function TopMatchesCard({
  title,
  href,
  groups,
  hasDefinitions,
  hasImport,
  isAdmin,
  adminHref,
  noun,
}: {
  title: string;
  href: string;
  groups: CompanyGroup[];
  hasDefinitions: boolean;
  hasImport: boolean;
  isAdmin: boolean;
  adminHref: string;
  noun: string;
}) {
  return (
    <section className="ef-card">
      <div className="mb-1 flex items-center justify-between gap-3">
        <p className="ef-subhead">{title}</p>
        {groups.length > 0 ? (
          <Link href={href} className="ef-btn ef-btn-text">
            See more
          </Link>
        ) : null}
      </div>
      <p className="ef-caption mb-4">Grouped by company, highest match score first.</p>

      {groups.length === 0 ? (
        <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
          {!hasImport ? (
            <>Upload a LinkedIn export and your {noun} matches show up here.</>
          ) : !hasDefinitions ? (
            isAdmin ? (
              <>
                No {noun}s defined yet, so nothing is being matched.{" "}
                <Link href={adminHref} style={{ color: "var(--blue-500)" }}>
                  Define one
                </Link>{" "}
                and every member&rsquo;s connections are scored automatically.
              </>
            ) : (
              <>An admin needs to define a {noun} before matches can appear here.</>
            )
          ) : (
            <>
              Nothing scored yet. Matching runs in the background after each
              import and whenever a {noun} changes — check back in a minute.
            </>
          )}
        </p>
      ) : (
        <ul className="flex flex-col gap-3" style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {groups.map((group) => (
            <li
              key={group.company}
              className="border-t pt-3 first:border-t-0 first:pt-0"
              style={{ borderColor: "var(--border-subtle)" }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="ef-small" style={{ fontWeight: 600 }}>
                  {group.company}
                </p>
                <span className="ef-caption" style={{ whiteSpace: "nowrap" }}>
                  {group.topScore} / 100
                </span>
              </div>
              <p className="ef-caption">
                {group.people.length} match
                {group.people.length === 1 ? "" : "es"} · {group.people[0].definitionName}
              </p>
              <ul className="mt-1 flex flex-col gap-1" style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {group.people.slice(0, 3).map((person, index) => (
                  <li key={`${person.name}-${index}`} className="ef-caption" title={person.rationale ?? undefined}>
                    {person.linkedinUrl ? (
                      <a
                        href={person.linkedinUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "var(--blue-500)" }}
                      >
                        {person.name}
                      </a>
                    ) : (
                      person.name
                    )}
                    {person.position ? ` — ${person.position}` : null}
                  </li>
                ))}
                {group.people.length > 3 ? (
                  <li className="ef-caption" style={{ color: "var(--neutral-400)" }}>
                    +{group.people.length - 3} more at this company
                  </li>
                ) : null}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
