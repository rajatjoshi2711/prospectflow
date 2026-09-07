import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { channelPartnerInputSchema, firstIssue } from "@/lib/matching/schemas";
import { requestMatchRecompute } from "@/lib/matching/trigger";

async function findOwned(id: string, organizationId: string) {
  return prisma.channelPartner.findFirst({
    where: { id, organizationId },
    select: { id: true },
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { session } = guard;
  const { id } = await params;

  if (!(await findOwned(id, session.organizationId))) {
    return NextResponse.json({ error: "Channel partner not found" }, { status: 404 });
  }

  const json = await request.json().catch(() => null);
  const parsed = channelPartnerInputSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  const partner = await prisma.channelPartner.update({
    where: { id },
    data: parsed.data,
    select: { id: true, name: true },
  });

  const queued = await requestMatchRecompute({
    organizationId: session.organizationId,
    icpIds: [],
    channelPartnerIds: [id],
    reason: `channel-partner-updated:${id}`,
  });

  return NextResponse.json({ channelPartner: partner, rescoreQueued: queued });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { session } = guard;
  const { id } = await params;

  if (!(await findOwned(id, session.organizationId))) {
    return NextResponse.json({ error: "Channel partner not found" }, { status: 404 });
  }

  // Matches cascade off the channelPartnerId FK.
  await prisma.channelPartner.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
