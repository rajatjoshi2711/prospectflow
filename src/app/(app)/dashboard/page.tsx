import { Children, type ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { getLatestCompleteBatch } from "@/lib/insights/prospects";
import { fetchTopMatchesByCompany, type CompanyGroup } from "@/lib/insights/matches";
import { getRelationshipScoringState } from "@/lib/relationship/state";
import {
  loadAwaitingReply,
  loadDormantHighValue,
  loadRecentlyConnectedNeverMessaged,
  ACTION_LIST_LIMIT,
  DORMANT_MONTHS,
  HIGH_VALUE_SCORE,
  RECENTLY_CONNECTED_DAYS,
  type ActionPerson,
} from "@/lib/insights/prospecting-actions";
import {
  loadInvitationAcceptance,
  loadReplyPerformance,
  ACCEPTANCE_CAVEATS,
} from "@/lib/insights/outreach-performance";
import { prospectHref } from "@/lib/prospects/person-key";
import { formatElapsed } from "@/lib/format/elapsed";
import { ScoringStatusCard } from "@/components/scoring-status";
import { StatCard } from "@/components/stat-card";
import { InvitationAcceptanceChart } from "@/components/invitation-acceptance-chart";

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

  const [connectionCount, jobChanges] = await Promise.all([
    batch ? prisma.connection.count({ where: { importBatchId: batch.id } }) : Promise.resolve(0),
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

  // Phase 7: scoring happens in Inngest, out of band, so the dashboard says
  // explicitly whether a run is in flight rather than leaving an unexplained
  // empty score column behind.
  const scoringState = await getRelationshipScoringState(session.userId, {
    hasCompletedImport: batch !== null,
  });

  // The five prospecting analytics. Every one of them is a SQL aggregate over
  // this one batch — the action lists come back capped at ACTION_LIST_LIMIT
  // rows plus a total, and the two performance measures come back as scalars.
  // Nothing here loads the batch's ~18.6k messages into this process. They run
  // as one round of parallel queries so the page waits once, not five times.
  const [awaitingReply, neverMessaged, dormant, acceptance, replyPerformance] = batch
    ? await Promise.all([
        loadAwaitingReply(batch.id, session.userId),
        loadRecentlyConnectedNeverMessaged(batch.id, session.userId),
        loadDormantHighValue(batch.id, session.userId),
        loadInvitationAcceptance(batch.id),
        loadReplyPerformance(batch.id),
      ])
    : [null, null, null, null, null];

  const daysSinceImport = daysSince(user?.lastImportAt ?? null);
  const needsReminder = daysSinceImport === null || daysSinceImport >= REMINDER_AFTER_DAYS;

  return (
    <div>
      <p className="ef-eyebrow mb-2">Dashboard</p>
      <h1 className="ef-page mb-2">Welcome back, {session.name.split(" ")[0]}</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 680 }}>
        Your personal view of the network you have imported: who moved jobs,
        who is worth a conversation, and when to refresh your data.
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
        <StatCard label="Connections" value={connectionCount.toLocaleString()} emphasis />
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

      <div className="mb-6">
        <ScoringStatusCard
          initialStatus={scoringState.status}
          initialScoredCount={scoringState.scoredCount}
          canRescoreOrg={session.role === "ADMIN"}
        />
      </div>

      <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
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

      {/* ------------------------------------------------------------------
          DO THIS NEXT — three lists of people, in the order they decay.
          A reply you owe is the most perishable thing on the page, so it
          leads. An empty list here is a GOOD outcome and says so.
         ------------------------------------------------------------------ */}
      <h2 className="ef-h3 mt-10 mb-1">Do this next</h2>
      <p className="ef-caption mb-4" style={{ maxWidth: 680 }}>
        People in your latest export who are waiting on something from you. Each
        list shows the {ACTION_LIST_LIMIT} most urgent; &ldquo;See all&rdquo; opens the
        whole list with the same search, sorting and paging as your connections.
      </p>

      <div className="flex flex-wrap gap-6">
        <ActionCard
          title="You owe them a reply"
          href="/actions/awaiting-reply"
          caption="Conversations where they wrote last and nothing went back."
          total={awaitingReply?.total ?? 0}
          hasImport={batch !== null}
          emptyMessage="Nothing waiting. Every conversation in your export ends with you."
          footnote={
            awaitingReply && awaitingReply.unknownLatest > 0
              ? `${awaitingReply.unknownLatest.toLocaleString()} conversation${
                  awaitingReply.unknownLatest === 1 ? "" : "s"
                } are not counted either way: their most recent message came from a group thread where the export does not say who sent it.`
              : undefined
          }
        >
          {awaitingReply?.items.map((item) => (
            <ActionRow
              key={`${item.identityKey ?? item.name}-${item.lastInboundAt.getTime()}`}
              person={item}
              detail={`Waiting ${formatElapsed(item.lastInboundAt)}`}
              showPosition
            />
          ))}
        </ActionCard>

        <ActionCard
          title="Connected, never messaged"
          href="/actions/new-connections"
          caption={`Accepted in the last ${RECENTLY_CONNECTED_DAYS} days with no message either way. Warmth fades fast after an accept.`}
          total={neverMessaged?.total ?? 0}
          hasImport={batch !== null}
          emptyMessage={`Nothing waiting. Everyone who accepted in the last ${RECENTLY_CONNECTED_DAYS} days has been spoken to.`}
        >
          {neverMessaged?.items.map((item) => (
            <ActionRow
              key={item.identityKey}
              person={item}
              detail={`Connected ${formatElapsed(item.connectedOn)} ago`}
            />
          ))}
        </ActionCard>

        <ActionCard
          title="Dormant, high value"
          href="/actions/dormant"
          caption={`Real message history, nothing for ${DORMANT_MONTHS}+ months, relationship strength ${HIGH_VALUE_SCORE} or above.`}
          total={dormant?.total ?? 0}
          hasImport={batch !== null}
          emptyMessage={`Nothing waiting. No strong relationship has gone quiet for ${DORMANT_MONTHS} months.`}
          // Strength is null until the scoring run reaches this batch. An
          // unscored network is "not known yet", never "nobody is valuable".
          override={
            batch !== null && dormant && dormant.scoredConnections === 0 ? (
              <>
                Relationship strength has not been calculated for this import yet
                — scoring runs in the background after an upload. This list needs
                it, so it stays empty until then rather than showing you an
                arbitrary set of names.
              </>
            ) : undefined
          }
        >
          {dormant?.items.map((item) => (
            <ActionRow
              key={item.identityKey}
              person={item}
              detail={`Strength ${item.relationshipScore} · last spoke ${formatElapsed(
                item.lastMessageAt,
              )} ago`}
            />
          ))}
        </ActionCard>
      </div>

      {/* ------------------------------------------------------------------
          IS YOUR OUTREACH WORKING? — two measures, both derived rather than
          recorded, both labelled as such.
         ------------------------------------------------------------------ */}
      <h2 className="ef-h3 mt-10 mb-1">Is your outreach working?</h2>
      <p className="ef-caption mb-4" style={{ maxWidth: 680 }}>
        Measured across all of your outreach, not split by ICP.
      </p>

      <div className="flex flex-wrap gap-6">
        <section className="ef-card" style={{ flex: "2 1 460px", minWidth: 0 }}>
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-3">
            <p className="ef-subhead">Invitation acceptance rate</p>
            <span className="ef-badge ef-badge-warning">Inferred</span>
          </div>
          <p className="ef-caption mb-4">
            By the month you sent the invitation.
          </p>

          {!batch ? (
            <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
              Upload a LinkedIn export and your invitation history shows up here.
            </p>
          ) : !acceptance || acceptance.points.length === 0 ? (
            <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
              {acceptance && acceptance.directionUnknown > 0
                ? `Your export has ${acceptance.directionUnknown.toLocaleString()} invitation records, but none of them are marked as sent by you — so there is nothing to measure acceptance against.`
                : "Your export contains no sent invitations, so there is no acceptance rate to show."}
            </p>
          ) : (
            <>
              <p className="ef-small mb-3">
                <strong>
                  {Math.round((acceptance.acceptedTotal / acceptance.sentTotal) * 100)}%
                </strong>{" "}
                overall — {acceptance.acceptedTotal.toLocaleString()} of{" "}
                {acceptance.sentTotal.toLocaleString()} sent invitations inferred accepted.
              </p>
              <InvitationAcceptanceChart points={acceptance.points} />
              {acceptance.undatedSent > 0 || acceptance.directionUnknown > 0 ? (
                <p className="ef-caption mt-2" style={{ color: "var(--text-secondary)" }}>
                  Not on this chart:{" "}
                  {[
                    acceptance.undatedSent > 0
                      ? `${acceptance.undatedSent.toLocaleString()} sent invitation${
                          acceptance.undatedSent === 1 ? "" : "s"
                        } with no date`
                      : null,
                    acceptance.directionUnknown > 0
                      ? `${acceptance.directionUnknown.toLocaleString()} invitation${
                          acceptance.directionUnknown === 1 ? "" : "s"
                        } whose direction the export does not state`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  .
                </p>
              ) : null}
              <details className="mt-3">
                <summary
                  className="ef-caption"
                  style={{ cursor: "pointer", color: "var(--blue-500)" }}
                >
                  How this is inferred, and what it cannot tell you
                </summary>
                <ul
                  className="mt-2 flex flex-col gap-2"
                  style={{ margin: "8px 0 0", padding: 0, listStyle: "none" }}
                >
                  {ACCEPTANCE_CAVEATS.map((caveat) => (
                    <li key={caveat} className="ef-caption" style={{ color: "var(--text-secondary)" }}>
                      {caveat}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </section>

        <section className="ef-card" style={{ flex: "1 1 320px", minWidth: 0 }}>
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-3">
            <p className="ef-subhead">Reply rate and speed</p>
            <span className="ef-badge ef-badge-warning">Derived</span>
          </div>
          <p className="ef-caption mb-4">
            One outreach is a run of messages you sent with no reply in between,
            so a follow-up does not count as a second attempt.
          </p>

          {!batch ? (
            <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
              Upload a LinkedIn export and your reply rate shows up here.
            </p>
          ) : !replyPerformance || replyPerformance.totalOutreach === 0 ? (
            <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
              {replyPerformance && replyPerformance.totalMessages > 0
                ? "Your export has messages, but none of them can be read as an outreach with a known direction inside a dated thread — so there is no reply rate to calculate."
                : "Your export contains no messages, so there is no reply rate to calculate."}
            </p>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap gap-6">
                <div>
                  <p className="ef-caption mb-1">Reply rate</p>
                  <p
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 700,
                      fontSize: "var(--fs-h3)",
                      lineHeight: "var(--lh-h3)",
                    }}
                  >
                    {Math.round(
                      (replyPerformance.repliedOutreach / replyPerformance.totalOutreach) * 100,
                    )}
                    %
                  </p>
                  <p className="ef-caption">
                    {replyPerformance.repliedOutreach.toLocaleString()} of{" "}
                    {replyPerformance.totalOutreach.toLocaleString()} outreaches
                  </p>
                </div>
                <div>
                  <p className="ef-caption mb-1">Median time to reply</p>
                  <p
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 700,
                      fontSize: "var(--fs-h3)",
                      lineHeight: "var(--lh-h3)",
                    }}
                  >
                    {replyPerformance.medianReplySeconds === null
                      ? "—"
                      : formatDuration(replyPerformance.medianReplySeconds)}
                  </p>
                  <p className="ef-caption">
                    {replyPerformance.medianReplySeconds === null
                      ? "No replies to measure"
                      : "Half of replies arrive sooner"}
                  </p>
                </div>
              </div>

              <p className="ef-caption" style={{ color: "var(--text-secondary)" }}>
                {replyPerformance.directionUnknownMessages === 0 &&
                replyPerformance.unthreadedMessages === 0 ? (
                  <>
                    All {replyPerformance.totalMessages.toLocaleString()} messages in this import
                    were used.
                  </>
                ) : (
                  <>
                    Excluded from both numbers, out of{" "}
                    {replyPerformance.totalMessages.toLocaleString()} messages in this import:{" "}
                    {[
                      replyPerformance.directionUnknownMessages > 0
                        ? `${replyPerformance.directionUnknownMessages.toLocaleString()} where the export does not say who sent them (group threads)`
                        : null,
                      replyPerformance.unthreadedMessages > 0
                        ? `${replyPerformance.unthreadedMessages.toLocaleString()} with no conversation id or no timestamp`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                    . A message of unknown direction is neither an outreach nor a reply, so it is
                    set aside rather than guessed at.
                  </>
                )}
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * One "do this next" list.
 *
 * Every empty state is distinguished, and an empty list is framed as the good
 * outcome it is: "nothing waiting", never an error and never a zero standing in
 * for missing data. `override` carries the one case where the list is empty for
 * a reason other than there being nothing to do.
 */
function ActionCard({
  title,
  caption,
  href,
  total,
  hasImport,
  emptyMessage,
  footnote,
  override,
  children,
}: {
  title: string;
  caption: string;
  /**
   * The list's own full page. The card is a preview of the first
   * ACTION_LIST_LIMIT rows; everything past that lives there, with the same
   * table, paging, sorting and search as /connections.
   */
  href: string;
  total: number;
  hasImport: boolean;
  emptyMessage: string;
  footnote?: string;
  override?: ReactNode;
  children: ReactNode;
}) {
  const rows = Children.toArray(children);
  const remaining = total - rows.length;

  return (
    <section className="ef-card" style={{ flex: "1 1 320px", minWidth: 0 }}>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <p className="ef-subhead">{title}</p>
        {total > 0 ? (
          <span className="ef-badge ef-badge-info">{total.toLocaleString()}</span>
        ) : null}
      </div>
      <p className="ef-caption mb-4">{caption}</p>

      {!hasImport ? (
        <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
          Upload a LinkedIn export and this list fills itself in.
        </p>
      ) : override ? (
        <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
          {override}
        </p>
      ) : rows.length === 0 ? (
        <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
          {emptyMessage}
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-3" style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {rows}
          </ul>
          <div className="mt-3 flex items-baseline gap-3">
            <Link href={href} className="ef-btn ef-btn-text" style={{ padding: 0 }}>
              See all {total.toLocaleString()}
            </Link>
            {remaining > 0 ? (
              <span className="ef-caption" style={{ color: "var(--neutral-400)" }}>
                +{remaining.toLocaleString()} more
              </span>
            ) : null}
          </div>
        </>
      )}

      {footnote ? (
        <p className="ef-caption mt-3" style={{ color: "var(--text-secondary)" }}>
          {footnote}
        </p>
      ) : null}
    </section>
  );
}

/**
 * One person on an action list.
 *
 * The name links to their prospect page when the message thread resolved to a
 * connection in this import. When it did not — a counterparty the export names
 * but does not connect to a profile — the name renders plain rather than
 * linking somewhere that would 404.
 */
function ActionRow({
  person,
  detail,
  showPosition = false,
}: {
  person: ActionPerson;
  detail: string;
  /**
   * Show their job title alongside the employer.
   *
   * Opt-in rather than on for every list: deciding who to reply to turns on
   * who the person actually is, so the reply list wants it. The other two
   * lists were not asked for it, and this component is shared — flipping it
   * there is one prop if that changes.
   */
  showPosition?: boolean;
}) {
  // Same convention as the prospect page header, so a person reads the same
  // way wherever they appear.
  const subtitle = showPosition
    ? [person.position, person.company].filter(Boolean).join(" · ")
    : (person.company ?? "");
  return (
    <li
      className="border-t pt-3 first:border-t-0 first:pt-0"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <p className="ef-small" style={{ fontWeight: 600 }}>
        {person.identityKey ? (
          <Link
            href={prospectHref(person.identityKey, "/dashboard")}
            style={{ color: "var(--blue-500)" }}
          >
            {person.name}
          </Link>
        ) : (
          person.name
        )}
      </p>
      {subtitle ? <p className="ef-caption">{subtitle}</p> : null}
      <p className="ef-caption" style={{ color: "var(--neutral-400)" }}>
        {detail}
      </p>
    </li>
  );
}

/** Seconds as the largest unit that still reads as a number, e.g. "4 hours". */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)} hours`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)} days`;
  return `${Math.round(days / 30)} months`;
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
