import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth/session";

/**
 * Admin edit of the organization's own profile.
 *
 * Scoping is taken from the session, never from the body: there is no `id`
 * parameter here at all, so an admin of one org has no way to address another
 * org's row even by guessing an id.
 *
 * `emailDomain` is not accepted. It is the key that routes new signups to an
 * org, and editing it from a form would strand existing members and quietly
 * send future signups somewhere else. See the schema comment.
 */

/**
 * Optional free-text field. Trimmed, and an emptied box is stored as NULL
 * rather than "" so "cleared" and "never set" read the same downstream.
 */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => value.trim())
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional();

const bodySchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  website: optionalText(200),
  industry: optionalText(120),
  location: optionalText(160),
  description: optionalText(2000),
});

/**
 * Accepts what people actually type ("emergeflow.com") and stores something a
 * browser can follow. Anything that is not a parseable http(s) URL after that
 * is rejected rather than stored, so the profile never renders a dead link.
 */
function normalizeWebsite(value: string): string | null {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // A hostname with no dot ("localhost", a typo) is not a public site.
  if (!parsed.hostname.includes(".")) return null;
  return parsed.toString();
}

export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
      { status: 400 },
    );
  }

  const { name, website, industry, location, description } = parsed.data;

  let normalizedWebsite: string | null = null;
  if (website) {
    normalizedWebsite = normalizeWebsite(website);
    if (!normalizedWebsite) {
      return NextResponse.json(
        { error: `"${website}" is not a valid website address.` },
        { status: 400 },
      );
    }
  }

  const organization = await prisma.organization.update({
    where: { id: session.organizationId },
    data: {
      name,
      website: normalizedWebsite,
      industry: industry ?? null,
      location: location ?? null,
      description: description ?? null,
    },
    select: {
      name: true,
      emailDomain: true,
      website: true,
      industry: true,
      location: true,
      description: true,
    },
  });

  return NextResponse.json({ organization });
}
