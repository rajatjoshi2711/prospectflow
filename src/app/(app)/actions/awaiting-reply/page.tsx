import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { ActionListPage } from "@/components/action-list-page";
import { fetchAwaitingReplyPage } from "@/lib/insights/prospecting-actions";
import { formatElapsed } from "@/lib/format/elapsed";

/**
 * The full "you owe them a reply" list.
 *
 * ROUTE: under `/actions/` with the other two, because these three pages are
 * one group — the dashboard's "Do this next" section — and they are reached
 * from there rather than from the sidebar.
 *
 * DEFAULT SORT: longest waiting first. That ordering is the entire point of
 * the list; anything else would bury the reply that has been owed the longest.
 */
export default async function AwaitingReplyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  return (
    <ActionListPage
      userId={session.userId}
      searchParams={await searchParams}
      sortKeys={["waiting", "name", "company", "strength"]}
      defaultSort="waiting"
      extraColumn={{ header: "Waiting", sortKey: "waiting" }}
      renderExtra={({ at }) => (
        <div>
          <div style={{ fontWeight: 600 }}>{formatElapsed(at)}</div>
          <div className="ef-caption">They wrote {at.toLocaleDateString()}</div>
        </div>
      )}
      load={fetchAwaitingReplyPage}
      copy={{
        title: "You owe them a reply",
        lead:
          "Conversations in your latest export where they wrote last and nothing went back. Longest waiting first.",
        nothingWaiting:
          "Every conversation in your export ends with you. There is nobody waiting on a reply.",
        footnote: (result) =>
          result.unlinked > 0 ? (
            <>
              {result.unlinked.toLocaleString()} more conversation
              {result.unlinked === 1 ? " is" : "s are"} waiting on a reply but did not match
              anyone in your connections file, so there is no row to show here. They still
              appear on the dashboard card, where the name is all that is known.
            </>
          ) : null,
      }}
    />
  );
}
