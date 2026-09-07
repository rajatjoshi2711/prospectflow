import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { IcpForm } from "@/components/icp-form";

export const dynamic = "force-dynamic";

export default async function AdminIcpDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/dashboard");

  const { id } = await params;

  // Scoped by organizationId, so an admin cannot open another org's ICP by id.
  const icp = await prisma.iCP.findFirst({
    where: { id, organizationId: session.organizationId },
    select: {
      id: true,
      name: true,
      country: true,
      industry: true,
      positions: true,
      description: true,
      _count: { select: { prospectMatches: true } },
    },
  });

  if (!icp) notFound();

  return (
    <div>
      <p className="ef-eyebrow mb-2">Admin</p>
      <h1 className="ef-page mb-2">{icp.name}</h1>
      <p className="ef-lead mb-2" style={{ maxWidth: 680 }}>
        Editing this definition re-scores every member&rsquo;s connections
        against it. Existing matches are updated in place, not duplicated.
      </p>
      <p className="ef-caption mb-8">
        {icp._count.prospectMatches.toLocaleString()} match
        {icp._count.prospectMatches === 1 ? "" : "es"} currently stored ·{" "}
        <Link href="/admin/icps" style={{ color: "var(--blue-500)" }}>
          Back to all ICPs
        </Link>
      </p>

      <IcpForm
        mode="edit"
        initial={{
          id: icp.id,
          name: icp.name,
          country: icp.country,
          industry: icp.industry,
          positions: icp.positions,
          description: icp.description,
        }}
      />
    </div>
  );
}
