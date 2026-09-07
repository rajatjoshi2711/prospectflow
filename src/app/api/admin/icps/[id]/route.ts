import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth/guards";
import { firstIssue, icpInputSchema } from "@/lib/matching/schemas";
import { requestMatchRecompute } from "@/lib/matching/trigger";

/**
 * Confirms the ICP exists AND belongs to the caller's org. Returning 404 (not
 * 403) for another org's id means the endpoint never confirms that an id
 * exists elsewhere.
 */
async function findOwned(id: string, organizationId: string) {
  return prisma.iCP.findFirst({ where: { id, organizationId }, select: { id: true } });
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
    return NextResponse.json({ error: "ICP not found" }, { status: 404 });
  }

  const json = await request.json().catch(() => null);
  const parsed = icpInputSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  const icp = await prisma.iCP.update({
    where: { id },
    data: parsed.data,
    select: { id: true, name: true },
  });

  // The definition changed, so every existing match against it is stale. The
  // recompute upserts survivors and prunes the rest.
  const queued = await requestMatchRecompute({
    organizationId: session.organizationId,
    icpIds: [id],
    channelPartnerIds: [],
    reason: `icp-updated:${id}`,
  });

  return NextResponse.json({ icp, rescoreQueued: queued });
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
    return NextResponse.json({ error: "ICP not found" }, { status: 404 });
  }

  // ProspectMatch cascades on the ICP FK, so its matches go with it — no
  // recompute needed.
  await prisma.iCP.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
