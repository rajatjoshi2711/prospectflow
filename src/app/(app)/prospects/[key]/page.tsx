import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { decodePersonKey } from "@/lib/prospects/person-key";
import {
  loadProspectDetail,
  type OrgCoverageEntry,
  type ProspectDetail,
  type ProspectMessage,
} from "@/lib/prospects/detail";
import { LEAD_STATUS_BADGE_CLASS, LEAD_STATUS_LABEL } from "@/lib/insights/status";
import { ConnectionMarkButtons } from "@/components/connection-mark-buttons";
import { ProspectNotes } from "@/components/prospect-notes";
import { ProspectResearch } from "@/components/prospect-research";

/**
 * One person.
 *
 * ADDRESSED BY `identityKey`, NOT BY `Connection.id` — see
 * `src/lib/prospects/person-key.ts`. Connection rows are recreated with new ids
 * on every import, so a connection-id URL would 404 after the next upload and
 * every bookmark would rot.
 *
 * TENANCY: the org id comes from the session, and `loadProspectDetail` filters
 * every read to import batches owned by that org's members. `identityKey` is a
 * GLOBAL person key — two unrelated companies can legitimately both know the
 * same person — so the org filter is what stops this page from ever showing one
 * org's data to another. A key that names nobody in the viewer's org is a 404,
 * not a peek.
 *
 * A PROSPECT WHO IS NOT IN THE VIEWER'S OWN SNAPSHOT still renders, provided a
 * colleague has them. That case is the product: "you don't know them, Priya
 * does" is the answer the org-coverage box exists to give, and 404ing it would
 * hide exactly the information worth surfacing. The page says so plainly — the
 * messages box explains there is no conversation because the person is not in
 * the viewer's own export, and the header details are labelled as coming from
 * the colleague's snapshot rather than passed off as the viewer's own.
 *
 * A PROSPECT IN NOBODY'S NETWORK also renders, provided they are a lead in one
 * of the VIEWER'S OWN campaigns — a cold lead off a spreadsheet is exactly the
 * person worth keeping notes and research against. Those pages are mostly
 * blank by nature, and every box says why rather than looking broken: the
 * header details are labelled as coming from the campaign file, and "nobody
 * here is connected to them" is stated as the finding it is.
 */
export default async function ProspectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const { key } = await params;
  const identityKey = decodePersonKey(key);
  if (!identityKey) {
    notFound();
  }

  const detail = await loadProspectDetail({
    identityKey,
    viewerId: session.userId,
    viewerRole: session.role,
    organizationId: session.organizationId,
  });
  if (!detail) {
    notFound();
  }

  const back = resolveBackLink(await searchParams);

  return (
    <div>
      <Link
        href={back.href}
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
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M15 18l-6-6 6-6" />
        </svg>
        {back.label}
      </Link>

      <ProspectHeader detail={detail} />

      <div className="flex flex-col gap-6">
        {/* Messages and research sit side by side: what you have already said to
            them, next to what the outside world says about them. Same
            wrap-at-a-basis pattern as the coverage/notes row below, so both
            columns fall to full width on a narrow screen without a breakpoint
            class — see `nav-shell.tsx` for the app's responsive behaviour. */}
        <div className="flex flex-wrap gap-6">
          <section className="ef-card" style={{ flex: "1 1 340px", minWidth: 300 }}>
            <h2 className="ef-h3 mb-1">Messages with them so far</h2>
            <p className="ef-caption mb-4">
              Read-only, from your most recent completed LinkedIn import.
            </p>
            <MessagesBox detail={detail} />
          </section>

          <section className="ef-card" style={{ flex: "1 1 340px", minWidth: 300 }}>
            <h2 className="ef-h3 mb-1">Research</h2>
            <p className="ef-caption mb-4">
              Recent news and one opening angle, from a live web search. Shared with everyone in{" "}
              {detail.organizationName}.
            </p>
            <ProspectResearch
              identityKey={detail.identityKey}
              personName={detail.name}
              research={detail.research}
            />
          </section>
        </div>

        <div className="flex flex-wrap gap-6">
          <section className="ef-card" style={{ flex: "1 1 340px", minWidth: 300 }}>
            <h2 className="ef-h3 mb-1">Who else knows them</h2>
            <p className="ef-caption mb-4">
              Across {detail.organizationName}&rsquo;s current imports.
            </p>
            <CoverageBox detail={detail} />
          </section>

          <section className="ef-card" style={{ flex: "1 1 340px", minWidth: 300 }}>
            <h2 className="ef-h3 mb-1">Notes</h2>
            <p className="ef-caption mb-4">
              Shared with everyone in {detail.organizationName}, newest first.
            </p>
            <ProspectNotes identityKey={detail.identityKey} notes={detail.notes} />
          </section>
        </div>
      </div>
    </div>
  );
}

function ProspectHeader({ detail }: { detail: ProspectDetail }) {
  return (
    <header className="mb-8">
      <p className="ef-eyebrow mb-2">Prospect</p>
      <h1 className="ef-page mb-2">{detail.name}</h1>
      <p className="ef-lead mb-4" style={{ maxWidth: 680 }}>
        {[detail.position, detail.company].filter(Boolean).join(" · ") ||
          "No title or company in the export."}
      </p>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        {detail.linkedinUrl ? (
          <a
            href={detail.linkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ef-btn ef-btn-secondary"
          >
            LinkedIn
            <span aria-hidden style={{ marginLeft: 6 }}>
              ↗
            </span>
            <span className="sr-only"> (opens their profile in a new tab)</span>
          </a>
        ) : (
          // Honest rather than a dead button: an export without a profile URL
          // genuinely gives us nowhere to send the reader.
          <span className="ef-small" style={{ color: "var(--neutral-400)" }}>
            No LinkedIn URL in the export
          </span>
        )}
        {/* Where the name, title and company above actually came from. Never
            left implicit: a campaign lead's details are whatever a spreadsheet
            said, which is a weaker claim than a LinkedIn export and must not
            be dressed up as one. */}
        {detail.snapshotDate ? (
          <span className="ef-caption">
            {detail.detailsFromMemberName
              ? `Details from ${detail.detailsFromMemberName}'s import on ${detail.snapshotDate.toLocaleDateString()}`
              : `Your snapshot of ${detail.snapshotDate.toLocaleDateString()}`}
          </span>
        ) : detail.detailsFromCampaignName ? (
          <span className="ef-caption">
            Details from your uploaded lead list for {detail.detailsFromCampaignName}, not from
            LinkedIn
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-4">
        <HeaderFact label="Status">
          {detail.status ? (
            <span className={`ef-badge ${LEAD_STATUS_BADGE_CLASS[detail.status]}`}>
              {LEAD_STATUS_LABEL[detail.status]}
            </span>
          ) : (
            <span className="ef-small" style={{ color: "var(--text-secondary)" }}>
              Not in your network
            </span>
          )}
        </HeaderFact>

        <HeaderFact label="Usefulness">
          <ConnectionMarkButtons
            // Remounts when the saved value changes, so the control's local
            // optimistic state never outlives the server value it started from.
            key={`${detail.identityKey}:${detail.mark ?? "none"}`}
            identityKey={detail.identityKey}
            personName={detail.name}
            initialValue={detail.mark}
          />
        </HeaderFact>

        <HeaderFact label="Relationship strength">
          <Strength
            score={detail.strength?.score ?? null}
            basis={detail.strength?.basis ?? null}
            factors={detail.strength?.factors}
          />
        </HeaderFact>
      </div>
    </header>
  );
}

function HeaderFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ef-card" style={{ minWidth: 220, flex: "0 1 260px" }}>
      <div className="ef-eyebrow mb-2">{label}</div>
      {children}
    </div>
  );
}

/**
 * Relationship strength, or an explicit "not yet scored".
 *
 * Mirrors `StrengthBar` in the prospect table, including the provenance label:
 * a 72 from the model and a 72 from the arithmetic rules are different claims.
 * A null score is never rendered as a zero — zero reads as "a bad relationship"
 * when the truth is "no interaction data to score from".
 */
function Strength({
  score,
  basis,
  factors,
}: {
  score: number | null;
  basis: "ai" | "heuristic" | null;
  factors?: string[];
}) {
  if (score === null) {
    return (
      <span
        className="ef-small"
        style={{ color: "var(--text-secondary)" }}
        title="No messages or invitation note for this person in your import, so there is nothing to score a relationship from. Not the same as a weak relationship."
      >
        Not yet scored
      </span>
    );
  }

  return (
    <div title={factors && factors.length > 0 ? factors.join(" · ") : undefined}>
      <div
        role="meter"
        aria-valuenow={score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Relationship strength out of 100"
        style={{ height: 8, borderRadius: 999, background: "var(--neutral-100)", overflow: "hidden" }}
      >
        <div
          style={{
            width: `${score}%`,
            height: "100%",
            borderRadius: 999,
            background:
              score >= 60 ? "var(--green-500)" : score >= 30 ? "var(--blue-400)" : "var(--neutral-300)",
          }}
        />
      </div>
      <div className="ef-caption mt-1 flex flex-wrap items-center gap-1">
        <span>{score} / 100</span>
        {basis === "heuristic" ? (
          <span
            style={{ color: "var(--neutral-400)" }}
            title="Calculated from message counts, recency and tenure — not an AI score."
          >
            · estimated
          </span>
        ) : basis === "ai" ? (
          <span
            style={{ color: "var(--neutral-400)" }}
            title="Scored by the AI pipeline from this person's interaction history."
          >
            · AI
          </span>
        ) : null}
      </div>
    </div>
  );
}

function MessagesBox({ detail }: { detail: ProspectDetail }) {
  const messages = detail.messages;

  if (messages.kind === "not-in-your-snapshot") {
    return (
      <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
        {detail.name} is not in your own latest import, so you have no
        conversation with them here.{" "}
        {detail.detailsFromCampaignName
          ? "They came from a lead list rather than from your network."
          : `See who in ${detail.organizationName} does, below.`}
      </p>
    );
  }

  if (messages.kind === "no-message-data") {
    return (
      <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
        Your export contained no messages at all, so there is nothing to show
        for anyone. LinkedIn only includes <code>messages.csv</code> in a full
        data export — request one from{" "}
        <Link href="/imports" style={{ color: "var(--blue-500)" }}>
          Imports
        </Link>{" "}
        to see conversations here.
      </p>
    );
  }

  if (messages.kind === "none") {
    return (
      <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
        No messages with {detail.name} in your export.
      </p>
    );
  }

  const hidden = messages.total - messages.shown;

  return (
    <div className="flex flex-col gap-3">
      {hidden > 0 ? (
        <p className="ef-caption">
          Showing the {messages.shown} most recent of {messages.total.toLocaleString()} messages.{" "}
          {hidden.toLocaleString()} older {hidden === 1 ? "message is" : "messages are"} not shown.
        </p>
      ) : (
        <p className="ef-caption">
          {messages.total.toLocaleString()} {messages.total === 1 ? "message" : "messages"}, oldest
          first.
        </p>
      )}
      <ul
        className="flex flex-col gap-3"
        style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 520, overflowY: "auto" }}
      >
        {messages.messages.map((message) => (
          <MessageRow key={message.id} message={message} personName={detail.name} />
        ))}
      </ul>
    </div>
  );
}

const DIRECTION_LABEL: Record<ProspectMessage["direction"], string> = {
  sent: "You sent",
  received: "They sent",
  // Not a guess: `MessageRecord.senderIsUser` is null when ingestion could not
  // identify the account owner in the export. Labelling it as one side or the
  // other would be inventing a fact.
  unknown: "Direction unknown",
};

/**
 * One message, as a chat bubble.
 *
 * Outgoing sits right and tinted, incoming sits left and neutral — the
 * convention every messaging app uses, so the direction of a conversation is
 * readable at a glance without reading the labels.
 *
 * A message whose direction ingestion could not determine gets neither side.
 * It is centered and muted instead, because putting it on the left or the
 * right would assert a fact the data does not contain. The label stays visible
 * on those, and is otherwise only exposed to screen readers: sighted users get
 * direction from the alignment, but alignment is invisible to a screen reader.
 */
function MessageRow({
  message,
  personName,
}: {
  message: ProspectMessage;
  personName: string;
}) {
  const label =
    message.direction === "received"
      ? `${personName} sent`
      : DIRECTION_LABEL[message.direction];

  const isSent = message.direction === "sent";
  const isUnknown = message.direction === "unknown";

  return (
    <li
      className="flex"
      style={{
        justifyContent: isUnknown ? "center" : isSent ? "flex-end" : "flex-start",
      }}
    >
      <div
        className="px-4 py-3"
        style={{
          maxWidth: isUnknown ? "92%" : "78%",
          background: isSent ? "var(--blue-50)" : isUnknown ? "transparent" : "#fff",
          border: `1px solid ${isUnknown ? "var(--border-subtle)" : isSent ? "var(--blue-100)" : "var(--border-subtle)"}`,
          borderStyle: isUnknown ? "dashed" : "solid",
          // The squared-off corner points at the sender, the way a tail would.
          borderRadius: isUnknown ? 10 : isSent ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
        }}
      >
        <div
          className="ef-caption mb-1 flex flex-wrap items-baseline gap-2"
          style={{ justifyContent: isSent ? "flex-end" : "flex-start" }}
        >
          {/* Alignment already conveys direction visually, but alignment is
              invisible to a screen reader — so the label stays in the
              accessibility tree via sr-only rather than being dropped. */}
          <span
            className={isUnknown ? undefined : "sr-only"}
            style={{
              fontWeight: 600,
              color: isUnknown ? "var(--neutral-400)" : "var(--text-secondary)",
            }}
          >
            {label}
          </span>
          <span>{message.sentAt ? message.sentAt.toLocaleString() : "No date in export"}</span>
        </div>
        {/* Message bodies are user content: rendered as text, never as markup.
            `pre-wrap` keeps the sender's own line breaks. */}
        <p className="ef-small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {message.body && message.body.trim().length > 0 ? (
            message.body
          ) : (
            <span style={{ color: "var(--neutral-400)" }}>(no message body in the export)</span>
          )}
        </p>
      </div>
    </li>
  );
}

function CoverageBox({ detail }: { detail: ProspectDetail }) {
  const others = detail.coverage.filter((entry) => !entry.isViewer);
  const viewer = detail.coverage.find((entry) => entry.isViewer) ?? null;

  if (others.length === 0) {
    return (
      // An empty list is a real finding for a cold lead, not a failure: it
      // means there is no warm path in and the approach has to be cold.
      <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
        {viewer
          ? `You are the only person in ${detail.organizationName} connected to them.`
          : detail.detailsFromCampaignName
            ? `Nobody in ${detail.organizationName} is connected to them — this is a cold lead. Notes and research below are still shared with your team.`
            : `Nobody in ${detail.organizationName} has them in their current import.`}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
        {viewer
          ? `You and ${others.length} other ${others.length === 1 ? "person" : "people"} in ${detail.organizationName} ${others.length === 1 ? "is" : "are"} connected to them.`
          : `You are not connected to them, but ${others.length} ${others.length === 1 ? "person" : "people"} in ${detail.organizationName} ${others.length === 1 ? "is" : "are"}.`}
      </p>
      <ul className="flex flex-col gap-2" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {detail.coverage.map((entry) => (
          <CoverageRow key={entry.userId} entry={entry} />
        ))}
      </ul>
    </div>
  );
}

function CoverageRow({ entry }: { entry: OrgCoverageEntry }) {
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] px-3 py-2"
      style={{ background: "var(--bg-subtle)" }}
    >
      <span className="ef-small" style={{ fontWeight: 600 }}>
        {entry.name}
        {entry.isViewer ? (
          <span className="ef-caption" style={{ marginLeft: 6, fontWeight: 400 }}>
            you
          </span>
        ) : null}
      </span>
      {/* Their score, from their own snapshot. Null is "not yet scored", never 0. */}
      {entry.score === null ? (
        <span
          className="ef-caption"
          title="No scoring run has reached this person in that member's import yet, or their export carried no interaction data."
        >
          Not yet scored
        </span>
      ) : (
        <span className="ef-caption">
          {entry.score} / 100
          {entry.basis === "heuristic" ? " · estimated" : entry.basis === "ai" ? " · AI" : ""}
        </span>
      )}
    </li>
  );
}

/**
 * Where "back" goes.
 *
 * The list pages pass their own path in `?from=`, following the pattern in the
 * campaign detail page of giving every entry point a way back to where it came
 * from. That value is reader-supplied, so it is validated to a path within this
 * app: it must start with a single `/`, which rules out both absolute URLs and
 * protocol-relative `//evil.example` — otherwise the back link would be an open
 * redirect wearing a breadcrumb's clothes.
 */
function resolveBackLink(params: Record<string, string | string[] | undefined>): {
  href: string;
  label: string;
} {
  const raw = Array.isArray(params.from) ? params.from[0] : params.from;
  const fallback = { href: "/connections", label: "All connections" };

  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return fallback;

  const path = raw.split("?")[0];
  const label =
    path === "/connections"
      ? "All connections"
      : path.startsWith("/companies")
        ? "Back to the company"
        : path.startsWith("/icps")
        ? "ICP dashboard"
        : path.startsWith("/channel-partners")
          ? "Channel partners"
          : path.startsWith("/campaigns")
            ? "Back to the campaign"
            : path.startsWith("/dashboard")
              ? "Dashboard"
              : "Back";

  return { href: raw, label };
}
