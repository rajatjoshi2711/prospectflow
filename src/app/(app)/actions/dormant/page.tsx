import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { ActionListPage } from "@/components/action-list-page";
import {
  DORMANT_MONTHS,
  HIGH_VALUE_SCORE,
  countScoredConnections,
  fetchDormantPage,
} from "@/lib/insights/prospecting-actions";
import { getLatestCompleteBatch } from "@/lib/insights/prospects";
import { formatElapsed } from "@/lib/format/elapsed";

/**
 * The full "dormant, high value" list.
 *
 * DEFAULT SORT: longest dormant first. The relationship-strength column is
 * sortable too, so "strongest first" is one click away — but the thing that
 * decays, and therefore the thing worth leading with, is the silence.
 *
 * The scoring caveat is the reason this page loads the batch a second time:
 * an empty list here means "nothing has gone quiet" only once relationship
 * scoring has actually run. Before that it means "not known yet", and saying
 * "nothing waiting" would be a lie dressed as good news.
 */
export default async function DormantPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const batch = await getLatestCompleteBatch(session.userId);
  const scoredConnections = batch ? await countScoredConnections(batch.id) : 0;

  return (
    <ActionListPage
      userId={session.userId}
      searchParams={await searchParams}
      sortKeys={["lastMessage", "name", "company", "strength"]}
      defaultSort="lastMessage"
      extraColumn={{ header: "Last spoke", sortKey: "lastMessage" }}
      renderExtra={({ at }) => (
        <div>
          <div style={{ fontWeight: 600 }}>{formatElapsed(at)} ago</div>
          <div className="ef-caption">{at.toLocaleDateString()}</div>
        </div>
      )}
      load={fetchDormantPage}
      copy={{
        title: "Dormant, high value",
        lead: `Real message history, nothing for ${DORMANT_MONTHS}+ months, relationship strength ${HIGH_VALUE_SCORE} or above. Longest silence first.`,
        nothingWaiting: `No relationship scored ${HIGH_VALUE_SCORE} or above has gone quiet for ${DORMANT_MONTHS} months. Nothing here has been left to cool.`,
        blocked:
          batch !== null && scoredConnections === 0 ? (
            <>
              Relationship strength has not been calculated for this import yet —
              scoring runs in the background after an upload. This list needs it,
              so it stays empty until then rather than showing you an arbitrary
              set of names.
            </>
          ) : undefined,
      }}
    />
  );
}
