import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guards";
import { consumeAiQuota, rateLimitResponse } from "@/lib/ai/rate-limit";
import { prisma } from "@/lib/prisma";
import { identityKeyBelongsToOrg } from "@/lib/prospects/detail";
import { ResearchUnavailableError, runProspectResearch } from "@/lib/prospects/research";

/**
 * Run live web research about one person, and save the result.
 *
 * SCOPING
 *   `organizationId` and `requestedById` come from the session and are never
 *   read from the body. `identityKey` is a GLOBAL person key and is not a
 *   foreign key, so it is checked against the org's own completed imports
 *   first — a hand-crafted key is a 404, not a paid-for search.
 *
 * COST
 *   This is the single most expensive request in the app: a web search plus a
 *   generation over what it retrieved. It gets its own tight bucket, checked
 *   AFTER validation (so a junk request cannot burn quota) and BEFORE the
 *   provider is touched (so a rejected one costs only a counter increment).
 *
 * FAILURE
 *   The row is written only after a complete, non-empty result comes back. A
 *   timeout or provider error returns an honest message and writes nothing —
 *   there is no half-saved run to mistake for research later.
 */

export const runtime = "nodejs";
// Search, then synthesise. Comfortably above the library's own 90s budget so a
// slow run returns its own error rather than being cut off by the platform.
export const maxDuration = 120;

export async function POST(request: Request) {
  const guard = await requireSession();
  if (!guard.ok) return guard.response;
  const { userId, organizationId } = guard.session;

  const payload = (await request.json().catch(() => null)) as { identityKey?: unknown } | null;
  const identityKey = typeof payload?.identityKey === "string" ? payload.identityKey.trim() : "";
  if (!identityKey) {
    return NextResponse.json({ error: "identityKey is required." }, { status: 400 });
  }

  if (!(await identityKeyBelongsToOrg(organizationId, identityKey))) {
    return NextResponse.json(
      { error: "No such person in your organization's network." },
      { status: 404 },
    );
  }

  const quota = await consumeAiQuota({ userId, organizationId, action: "prospect-research" });
  if (!quota.ok) return rateLimitResponse(quota);

  // The subject comes from the org's own imports, not from the request body,
  // for the same reason the tenancy fields do: the caller picks WHO, the server
  // decides what is known about them.
  const subject = await loadSubject(organizationId, identityKey);
  if (!subject) {
    return NextResponse.json(
      { error: "No such person in your organization's network." },
      { status: 404 },
    );
  }

  try {
    const result = await runProspectResearch(subject);

    const saved = await prisma.prospectResearch.create({
      data: {
        organizationId,
        identityKey,
        requestedById: userId,
        summary: result.summary,
        citations: result.citations,
        model: result.model,
      },
      select: { id: true, createdAt: true },
    });

    return NextResponse.json({
      ok: true,
      id: saved.id,
      createdAt: saved.createdAt,
      summary: result.summary,
      citations: result.citations,
    });
  } catch (error) {
    if (error instanceof ResearchUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Prospect research failed", error);
    return NextResponse.json(
      { error: "The research run failed. Nothing was saved — try again in a moment." },
      { status: 500 },
    );
  }
}

/** The most recent snapshot in the org that names this person. */
async function loadSubject(organizationId: string, identityKey: string) {
  const connection = await prisma.connection.findFirst({
    where: { identityKey, importBatch: { status: "COMPLETE", user: { organizationId } } },
    orderBy: [{ importBatch: { completedAt: "desc" } }, { createdAt: "desc" }],
    select: {
      firstName: true,
      lastName: true,
      position: true,
      company: true,
      linkedinUrl: true,
    },
  });
  if (!connection) return null;

  const name = [connection.firstName, connection.lastName].filter(Boolean).join(" ").trim();
  // Without a name there is nothing to search for, and a search on a title
  // alone would return someone else's news attributed to this person.
  if (!name) return null;

  return {
    name,
    position: connection.position,
    company: connection.company,
    linkedinUrl: connection.linkedinUrl,
  };
}
