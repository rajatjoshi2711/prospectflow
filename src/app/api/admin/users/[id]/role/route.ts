import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";

const bodySchema = z.object({
  role: z.enum(["ADMIN", "MEMBER"]),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body. Expected { role: 'ADMIN' | 'MEMBER' }." },
      { status: 400 },
    );
  }

  const targetUser = await prisma.user.findUnique({ where: { id } });
  if (!targetUser || targetUser.organizationId !== session.organizationId) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Prevent an admin from demoting themselves if they're the last admin in
  // the organization, so an org can never end up with zero admins.
  if (
    targetUser.id === session.userId &&
    parsed.data.role === "MEMBER"
  ) {
    const adminCount = await prisma.user.count({
      where: { organizationId: session.organizationId, role: "ADMIN" },
    });
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: "You are the only admin. Promote someone else first." },
        { status: 400 },
      );
    }
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { role: parsed.data.role },
    select: { id: true, name: true, email: true, role: true },
  });

  return NextResponse.json({ user: updated });
}
