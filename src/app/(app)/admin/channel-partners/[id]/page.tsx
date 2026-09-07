import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ChannelPartnerForm } from "@/components/channel-partner-form";

export const dynamic = "force-dynamic";

export default async function AdminChannelPartnerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/dashboard");

  const { id } = await params;

  const partner = await prisma.channelPartner.findFirst({
    where: { id, organizationId: session.organizationId },
    select: {
      id: true,
      name: true,
      industry: true,
      criteria: true,
      _count: { select: { prospectMatches: true } },
    },
  });

  if (!partner) notFound();

  return (
    <div>
      <p className="ef-eyebrow mb-2">Admin</p>
      <h1 className="ef-page mb-2">{partner.name}</h1>
      <p className="ef-lead mb-2" style={{ maxWidth: 680 }}>
        Editing this definition re-scores every member&rsquo;s connections
        against it. Existing matches are updated in place, not duplicated.
      </p>
      <p className="ef-caption mb-8">
        {partner._count.prospectMatches.toLocaleString()} match
        {partner._count.prospectMatches === 1 ? "" : "es"} currently stored ·{" "}
        <Link href="/admin/channel-partners" style={{ color: "var(--blue-500)" }}>
          Back to all channel partners
        </Link>
      </p>

      <ChannelPartnerForm
        mode="edit"
        initial={{
          id: partner.id,
          name: partner.name,
          industry: partner.industry,
          criteria: partner.criteria,
        }}
      />
    </div>
  );
}
