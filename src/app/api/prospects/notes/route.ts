import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { identityKeyIsVisible } from "@/lib/prospects/detail";

/**
 * Add a note about one person, visible to the author's whole organization.
 *
 * SCOPING
 *   `organizationId` and `authorId` come from the session and are never read
 *   from the body, so there is no id to tamper with: a caller cannot write a
 *   note into another org, nor attribute one to a colleague.
 *
 * WHY THE identityKey IS VERIFIED BEFORE WRITING
 *   `ProspectNote.identityKey` is not a foreign key — the person it names
 *   outlives any single `Connection` row — so the database alone would accept
 *   arbitrary strings. `identityKeyIsVisible` keeps the table to people the
 *   author can legitimately see — anyone in the ORG's completed imports, or a
 *   lead in one of their OWN campaigns — and turns a junk key into a 404 rather
 *   than a stored row. It is exactly the rule that decides whether the prospect
 *   page renders, so a note is possible for every person a note can be read on.
 *   The note itself stays org-visible.
 */

export const runtime = "nodejs";

/** Long enough for real context, short enough that one note cannot be a payload. */
const MAX_NOTE_LENGTH = 4000;

export async function POST(request: Request) {
  const guard = await requireSession();
  if (!guard.ok) return guard.response;
  const { userId, organizationId } = guard.session;

  const payload = (await request.json().catch(() => null)) as
    | { identityKey?: unknown; body?: unknown }
    | null;

  const identityKey = typeof payload?.identityKey === "string" ? payload.identityKey.trim() : "";
  if (!identityKey) {
    return NextResponse.json({ error: "identityKey is required." }, { status: 400 });
  }

  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (!body) {
    return NextResponse.json({ error: "A note cannot be empty." }, { status: 400 });
  }
  if (body.length > MAX_NOTE_LENGTH) {
    return NextResponse.json(
      { error: `A note can be at most ${MAX_NOTE_LENGTH} characters.` },
      { status: 400 },
    );
  }

  if (!(await identityKeyIsVisible({ organizationId, viewerId: userId, identityKey }))) {
    return NextResponse.json(
      { error: "No such person in your organization's network." },
      { status: 404 },
    );
  }

  const note = await prisma.prospectNote.create({
    data: { organizationId, identityKey, authorId: userId, body },
    select: { id: true, createdAt: true },
  });

  return NextResponse.json({ ok: true, id: note.id, createdAt: note.createdAt });
}
