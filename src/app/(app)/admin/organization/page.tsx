import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { OrganizationForm } from "@/components/organization-form";

/**
 * Admin: organization settings.
 *
 * Admin-gated the same way every other page under /admin is — members see the
 * org's name and details across the app but cannot rewrite them.
 */
export default async function AdminOrganizationPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  if (session.role !== "ADMIN") {
    redirect("/dashboard");
  }

  const organization = await prisma.organization.findUnique({
    where: { id: session.organizationId },
    select: {
      name: true,
      emailDomain: true,
      website: true,
      industry: true,
      location: true,
      description: true,
    },
  });

  // A valid session always has an org behind it, so a miss here is a real
  // anomaly rather than an ordinary empty state.
  if (!organization) notFound();

  return (
    <div>
      <p className="ef-eyebrow mb-2">Admin</p>
      <h1 className="ef-page mb-2">Organization</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 640 }}>
        These details identify your organization across ProspectFlow. Everyone
        on the team can see them; only admins can change them.
      </p>
      <OrganizationForm initial={organization} />
    </div>
  );
}
