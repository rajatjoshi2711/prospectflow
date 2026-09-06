import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { NavShell } from "@/components/nav-shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const organization = await prisma.organization.findUnique({
    where: { id: session.organizationId },
    select: { name: true },
  });

  return (
    <NavShell
      name={session.name}
      email={session.email}
      role={session.role}
      orgName={organization?.name ?? "Your organization"}
    >
      {children}
    </NavShell>
  );
}
