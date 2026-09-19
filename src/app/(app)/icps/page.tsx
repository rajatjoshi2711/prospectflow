import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { MatchDashboard } from "@/components/match-dashboard";

export const dynamic = "force-dynamic";

export default async function IcpsDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <MatchDashboard
      matchType="ICP"
      userId={session.userId}
      organizationId={session.organizationId}
      isAdmin={session.role === "ADMIN"}
      searchParams={await searchParams}
      // ICPs only. The people you fit your Ideal Customer Profile and have
      // never written to are the most actionable thing on this page, so the
      // count sits above the table with a one-click filter. Channel partners
      // deliberately do not get it — see `MatchDashboard`'s `neverMessaged`.
      neverMessaged
      copy={{
        eyebrow: "Prospects",
        title: "ICP matches",
        lead:
          "Everyone in your latest import who fits one of your organization's Ideal Customer Profiles, scored and explained.",
        noun: "ICP",
        adminHref: "/admin/icps",
        adminLabel: "Define your first ICP",
      }}
    />
  );
}
