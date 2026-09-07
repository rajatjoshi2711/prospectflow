import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { channelPartnerInputSchema, firstIssue } from "@/lib/matching/schemas";
import { requestMatchRecompute } from "@/lib/matching/trigger";

/** Creates a channel partner for the caller's organization and re-scores. */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { session } = guard;

  const json = await request.json().catch(() => null);
  const parsed = channelPartnerInputSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  const partner = await prisma.channelPartner.create({
    data: { ...parsed.data, organizationId: session.organizationId },
    select: { id: true, name: true },
  });

  const queued = await requestMatchRecompute({
    organizationId: session.organizationId,
    icpIds: [],
    channelPartnerIds: [partner.id],
    reason: `channel-partner-created:${partner.id}`,
  });

  return NextResponse.json({ channelPartner: partner, rescoreQueued: queued }, { status: 201 });
}
