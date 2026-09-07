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
