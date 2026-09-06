import { ComingSoon } from "@/components/coming-soon";

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await params;
  return (
    <ComingSoon
      title="Campaign detail"
      description="Per-lead status tracking and connection matching arrive with campaigns."
      phase="Phase 5 — campaigns"
    />
  );
}
