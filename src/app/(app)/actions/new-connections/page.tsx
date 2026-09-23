import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { ActionListPage } from "@/components/action-list-page";
import {
  RECENTLY_CONNECTED_DAYS,
  fetchNeverMessagedPage,
} from "@/lib/insights/prospecting-actions";
import { formatElapsed } from "@/lib/format/elapsed";

/**
 * The full "recently connected, never messaged" list.
 *
 * DEFAULT SORT: most recently connected first. Warmth after an accept fades,
 * so the newest accept is the one still worth a first message today.
 */
export default async function NewConnectionsPage({
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
      sortKeys={["connectedOn", "name", "company", "strength"]}
      defaultSort="connectedOn"
      extraColumn={{ header: "Connected", sortKey: "connectedOn" }}
      renderExtra={({ at }) => (
        <div>
          <div style={{ fontWeight: 600 }}>{at.toLocaleDateString()}</div>
          <div className="ef-caption">{formatElapsed(at)} ago</div>
        </div>
      )}
      load={fetchNeverMessagedPage}
      copy={{
        title: "Connected, never messaged",
        lead: `People who accepted in the last ${RECENTLY_CONNECTED_DAYS} days with no message either way in your latest export. Most recent accept first.`,
        nothingWaiting: `Everyone who accepted in the last ${RECENTLY_CONNECTED_DAYS} days has been spoken to. Nothing is going cold.`,
      }}
    />
  );
}
