import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { UserRoleTable } from "@/components/user-role-table";

export default async function AdminUsersPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  if (session.role !== "ADMIN") {
    redirect("/dashboard");
  }

  const users = await prisma.user.findMany({
    where: { organizationId: session.organizationId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });

  return (
    <div>
      <p className="ef-eyebrow mb-2">Admin</p>
      <h1 className="ef-page mb-2">User management</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 640 }}>
        Everyone who signs up with an @{" "}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 14 }}>
          {users[0]?.email.split("@")[1]}
        </span>{" "}
        email joins this organization automatically. Promote or demote them
        below.
      </p>
      <UserRoleTable
        users={users.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() }))}
        currentUserId={session.userId}
      />
    </div>
  );
}
