import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { IcpForm } from "@/components/icp-form";

export const dynamic = "force-dynamic";

export default async function AdminIcpsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  // Redirect is the UI half of the guard; the API routes enforce it again
  // server-side so hiding the page is never the only protection.
  if (session.role !== "ADMIN") redirect("/dashboard");

  const icps = await prisma.iCP.findMany({
    where: { organizationId: session.organizationId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      country: true,
      industry: true,
      positions: true,
      description: true,
      updatedAt: true,
      _count: { select: { prospectMatches: true } },
    },
  });

  return (
    <div>
      <p className="ef-eyebrow mb-2">Admin</p>
      <h1 className="ef-page mb-2">ICP definitions</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 680 }}>
        Define who your organization sells to. Every connection in every
        member&rsquo;s latest import is scored against these, and the results
        show up on the ICPs dashboard.
      </p>

      <section className="mb-10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="ef-h3">Current ICPs</h2>
          <span className="ef-caption">{icps.length} defined</span>
        </div>

        {icps.length === 0 ? (
          <div className="ef-card ef-rise" style={{ maxWidth: 560 }}>
            <span className="ef-badge ef-badge-info">Nothing defined yet</span>
            <p className="ef-small mt-3" style={{ color: "var(--text-secondary)" }}>
              No ICPs yet, so nothing is being matched. Create your first one
              below — you can refine it at any time and everything re-scores.
            </p>
          </div>
        ) : (
          <div className="ef-card overflow-x-auto p-0">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr style={{ background: "var(--bg-subtle)" }}>
                  {["Name", "Country", "Industry", "Positions", "Matches", "Updated", ""].map(
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
                {icps.map((icp) => (
                  <tr key={icp.id} className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                    <td className="ef-small px-5 py-3" style={{ fontWeight: 600 }}>
                      {icp.name}
                    </td>
                    <td className="ef-small px-5 py-3">{icp.country ?? "Any"}</td>
                    <td className="ef-small px-5 py-3">{icp.industry ?? "—"}</td>
                    <td className="ef-small px-5 py-3" style={{ maxWidth: 260 }}>
                      {icp.positions.length > 0 ? icp.positions.join(", ") : "—"}
                    </td>
                    <td className="ef-small px-5 py-3">
                      {icp._count.prospectMatches.toLocaleString()}
                    </td>
                    <td className="ef-small px-5 py-3">{icp.updatedAt.toLocaleDateString()}</td>
                    <td className="px-5 py-3">
                      <Link href={`/admin/icps/${icp.id}`} className="ef-btn ef-btn-secondary" style={{ fontSize: 13, padding: "6px 12px" }}>
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
        <h2 className="ef-h3 mb-3">Add an ICP</h2>
        <IcpForm mode="create" />
      </section>
    </div>
  );
}
