import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { MatchDashboard } from "@/components/match-dashboard";

export const dynamic = "force-dynamic";

export default async function ChannelPartnersDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <MatchDashboard
      matchType="CHANNEL_PARTNER"
      userId={session.userId}
      organizationId={session.organizationId}
      isAdmin={session.role === "ADMIN"}
      searchParams={await searchParams}
      copy={{
        eyebrow: "Prospects",
        title: "Channel partner matches",
        lead:
          "Everyone in your latest import who fits one of your organization's channel partner definitions, scored and explained.",
        noun: "Channel partner",
        adminHref: "/admin/channel-partners",
        adminLabel: "Define your first channel partner",
      }}
    />
  );
}
