import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { firstIssue, icpInputSchema } from "@/lib/matching/schemas";
import { requestMatchRecompute } from "@/lib/matching/trigger";

/** Creates an ICP for the caller's organization and queues a re-score. */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { session } = guard;

  const json = await request.json().catch(() => null);
  const parsed = icpInputSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  const icp = await prisma.iCP.create({
    data: { ...parsed.data, organizationId: session.organizationId },
    select: { id: true, name: true },
  });

  const queued = await requestMatchRecompute({
    organizationId: session.organizationId,
    icpIds: [icp.id],
    channelPartnerIds: [],
    reason: `icp-created:${icp.id}`,
  });

  return NextResponse.json({ icp, rescoreQueued: queued }, { status: 201 });
}
