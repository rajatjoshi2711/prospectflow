import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ChannelPartnerForm } from "@/components/channel-partner-form";

export const dynamic = "force-dynamic";

export default async function AdminChannelPartnersPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/dashboard");

  const partners = await prisma.channelPartner.findMany({
    where: { organizationId: session.organizationId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      industry: true,
      criteria: true,
      updatedAt: true,
      _count: { select: { prospectMatches: true } },
    },
  });

  return (
    <div>
      <p className="ef-eyebrow mb-2">Admin</p>
      <h1 className="ef-page mb-2">Channel partner definitions</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 680 }}>
        Define the kinds of firms and people worth partnering with. Connections
        are scored against these the same way they are against ICPs.
      </p>

      <section className="mb-10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="ef-h3">Current channel partners</h2>
          <span className="ef-caption">{partners.length} defined</span>
        </div>

        {partners.length === 0 ? (
          <div className="ef-card ef-rise" style={{ maxWidth: 560 }}>
            <span className="ef-badge ef-badge-info">Nothing defined yet</span>
            <p className="ef-small mt-3" style={{ color: "var(--text-secondary)" }}>
              No channel partners defined, so the channel partners dashboard is
              empty. Add one below to start matching.
            </p>
          </div>
        ) : (
          <div className="ef-card overflow-x-auto p-0">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr style={{ background: "var(--bg-subtle)" }}>
                  {["Name", "Industry", "Criteria", "Matches", "Updated", ""].map(
                    (header, index) => (
                      <th
                        key={header || `col-${index}`}
                        className="ef-small px-5 py-3"
                        style={{ fontWeight: 700 }}
                      >
                        {header}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {partners.map((partner) => (
                  <tr
                    key={partner.id}
                    className="border-t"
                    style={{ borderColor: "var(--border-subtle)" }}
                  >
                    <td className="ef-small px-5 py-3" style={{ fontWeight: 600 }}>
                      {partner.name}
                    </td>
                    <td className="ef-small px-5 py-3">{partner.industry ?? "—"}</td>
                    <td className="ef-small px-5 py-3" style={{ maxWidth: 320 }}>
                      {partner.criteria ? truncate(partner.criteria, 120) : "—"}
                    </td>
                    <td className="ef-small px-5 py-3">
                      {partner._count.prospectMatches.toLocaleString()}
                    </td>
                    <td className="ef-small px-5 py-3">{partner.updatedAt.toLocaleDateString()}</td>
                    <td className="px-5 py-3">
                      <Link
                        href={`/admin/channel-partners/${partner.id}`}
                        className="ef-btn ef-btn-secondary"
                        style={{ fontSize: 13, padding: "6px 12px" }}
                      >
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="ef-h3 mb-3">Add a channel partner</h2>
        <ChannelPartnerForm mode="create" />
      </section>
    </div>
  );
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`;
}
