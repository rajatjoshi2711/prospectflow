import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { fetchConnectionsOverTime, listOrgMembers } from "@/lib/insights/org";
import { ConnectionsOverTimeChart } from "@/components/connections-over-time-chart";
import {
  QuickSuggestionsPanel,
  type QuickSuggestionView,
} from "@/components/quick-suggestions-panel";

/**
 * Org dashboard (build plan feature #3).
 *
 * Visible to every member, not just admins: the point of ProspectFlow is that
 * one person's network is the whole team's asset, so everyone can see who is on
 * the team, how each network is growing, and what the org should act on next.
 * Nothing here mutates a definition, so there is no admin gate.
 *
 * EMPTY STATES ARE FIRST-CLASS
 *   - a single-member org gets the table and (if they have imported) their own
 *     series, with no legend and no "compare" framing;
 *   - no imports at all -> the chart is replaced by a prompt to upload, not by
 *     an empty axis;
 *   - no suggestions yet -> an explanation of when they appear, not a blank box.
 */

const MAX_SUGGESTIONS_SHOWN = 8;

export default async function OrgDashboardPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const [organization, members, series, suggestions] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: session.organizationId },
      select: { name: true, emailDomain: true },
    }),
    listOrgMembers(session.organizationId),
    fetchConnectionsOverTime(session.organizationId),
    // Org-scoped, and dismissed rows are excluded — they are kept in the table
    // only as tombstones so the generator does not resurrect them.
    prisma.quickSuggestion.findMany({
      where: { organizationId: session.organizationId, dismissed: false },
      orderBy: { createdAt: "desc" },
      take: MAX_SUGGESTIONS_SHOWN,
      select: {
        id: true,
        title: true,
        suggestionText: true,
        metadata: true,
        sourceUser: { select: { name: true } },
        targetConnection: { select: { firstName: true, lastName: true, company: true } },
      },
    }),
  ]);

  const totalConnections = members.reduce((sum, member) => sum + member.connectionCount, 0);
  const membersWithImports = members.filter((member) => member.latestBatchId !== null).length;

  const suggestionViews: QuickSuggestionView[] = suggestions.map((suggestion) => {
    const metadata = (suggestion.metadata ?? {}) as {
      matchScore?: unknown;
      relationshipScore?: unknown;
      basis?: unknown;
    };
    return {
      id: suggestion.id,
      title: suggestion.title,
      text: suggestion.suggestionText,
      sourceUserName: suggestion.sourceUser.name,
      personName:
        [suggestion.targetConnection.firstName, suggestion.targetConnection.lastName]
          .filter(Boolean)
          .join(" ")
          .trim() || null,
      company: suggestion.targetConnection.company,
      matchScore: typeof metadata.matchScore === "number" ? metadata.matchScore : null,
      // Null is meaningful: the relationship has not been scored. It is rendered
      // as "not yet scored", never as a zero.
      relationshipScore:
        typeof metadata.relationshipScore === "number" ? metadata.relationshipScore : null,
      basis: metadata.basis === "ai" ? "ai" : "heuristic",
    };
  });

  return (
    <div>
      <p className="ef-eyebrow mb-2">Organization</p>
      <h1 className="ef-page mb-2">{organization?.name ?? "Your organization"}</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 640 }}>
        Everyone on {organization?.emailDomain ?? "your domain"}, how their networks are
        growing, and what the team should act on next.
      </p>

      <div className="mb-8 flex flex-wrap gap-4">
        <StatCard label="Members" value={members.length.toLocaleString()} />
        <StatCard
          label="Connections in current snapshots"
          value={totalConnections.toLocaleString()}
        />
        <StatCard
          label="Members who have imported"
          value={`${membersWithImports} of ${members.length}`}
        />
      </div>

      <section className="ef-card ef-rise mb-8">
        <h2 className="ef-h3 mb-1">Quick suggestions</h2>
        <p className="ef-caption mb-4" style={{ color: "var(--text-secondary)" }}>
          Who should reach out to whom, drawn from the whole org&apos;s connection graph —
          ICP matches, relationship strength, and who already knows the person.
        </p>
        {suggestionViews.length > 0 ? (
          <QuickSuggestionsPanel suggestions={suggestionViews} />
        ) : (
          <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
            {membersWithImports === 0
              ? "Nothing to suggest yet — no one has imported a LinkedIn export. Suggestions are generated from real matches, never invented."
              : "No suggestions yet. They are generated after an import completes and refreshed overnight, and they need at least one ICP or channel partner to score against."}
          </p>
        )}
      </section>

      <section className="ef-card ef-rise mb-8">
        <h2 className="ef-h3 mb-1">Members</h2>
        <p className="ef-caption mb-4" style={{ color: "var(--text-secondary)" }}>
          Connection counts come from each person&apos;s most recent completed import.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Role</Th>
                <Th align="right">Connections</Th>
                <Th>Last import</Th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                  <Td>
                    <span style={{ fontWeight: 600 }}>{member.name}</span>
                    <span
                      className="ef-caption"
                      style={{ display: "block", color: "var(--text-secondary)" }}
                    >
                      {member.email}
                    </span>
                  </Td>
                  <Td>
                    <span
                      className={`ef-badge ${
                        member.role === "ADMIN" ? "ef-badge-info" : "ef-badge-neutral"
                      }`}
                    >
                      {member.role === "ADMIN" ? "Admin" : "Member"}
                    </span>
                  </Td>
                  <Td align="right">
                    {member.latestBatchId ? (
                      member.connectionCount.toLocaleString()
                    ) : (
                      <span style={{ color: "var(--text-secondary)" }}>No import yet</span>
                    )}
                  </Td>
                  <Td>
                    {member.latestBatchAt ? (
                      member.latestBatchAt.toLocaleDateString()
                    ) : (
                      <span style={{ color: "var(--text-secondary)" }}>—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="ef-card ef-rise">
        <h2 className="ef-h3 mb-1">Connections over time</h2>
        <p className="ef-caption mb-4" style={{ color: "var(--text-secondary)" }}>
          One point per completed import. Every upload is kept as a dated snapshot, so
          these are measurements rather than estimates.
        </p>
        {series.length > 0 ? (
          <ConnectionsOverTimeChart series={series} />
        ) : (
          <div>
            <p className="ef-small mb-3" style={{ color: "var(--text-secondary)" }}>
              No completed imports in this organization yet, so there is no history to plot.
            </p>
            <Link href="/imports" className="ef-btn ef-btn-primary">
              Upload your export
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="ef-card ef-card-stat" style={{ minWidth: 200, flex: "1 1 200px" }}>
      <span className="ef-stat-number">{value}</span>
      <span className="ef-caption" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th
      className="ef-caption"
      style={{
        textAlign: align ?? "left",
        padding: "8px 12px",
        color: "var(--text-secondary)",
        fontWeight: 600,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <td className="ef-small" style={{ textAlign: align ?? "left", padding: "12px" }}>
      {children}
    </td>
  );
}
