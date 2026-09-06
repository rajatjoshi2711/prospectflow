import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

/** Lists the current user's import batches, newest first, for the imports
 * page's client-side refresh/poll. */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const batches = await prisma.importBatch.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      fileCount: true,
      errorMessage: true,
      createdAt: true,
      completedAt: true,
      _count: { select: { jobChangeEventsAsCurrent: true } },
    },
  });

  return NextResponse.json({
    batches: batches.map((b) => ({
      id: b.id,
      status: b.status,
      fileCount: b.fileCount,
      errorMessage: b.errorMessage,
      createdAt: b.createdAt.toISOString(),
      completedAt: b.completedAt ? b.completedAt.toISOString() : null,
      jobChangeCount: b._count.jobChangeEventsAsCurrent,
    })),
  });
}
