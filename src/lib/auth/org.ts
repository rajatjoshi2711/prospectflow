import "server-only";

import { prisma } from "@/lib/prisma";

// Free/consumer email providers should never become an "organization" by
// domain alone. Kept small and explicit; extend as needed.
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "aol.com",
  "protonmail.com",
]);

export function getEmailDomain(email: string): string {
  const domain = email.split("@")[1]?.toLowerCase().trim();
  if (!domain) {
    throw new Error("Invalid email address: missing domain.");
  }
  return domain;
}

export function isPersonalEmailDomain(domain: string): boolean {
  return PERSONAL_EMAIL_DOMAINS.has(domain);
}

function titleCaseFromDomain(domain: string): string {
  const label = domain.split(".")[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Finds the organization for an email domain, or creates one if this is the
 * first signup from that domain. Returns the organization along with whether
 * it was just created (the caller uses this to decide ADMIN vs MEMBER).
 */
export async function findOrCreateOrganizationForDomain(domain: string) {
  const existing = await prisma.organization.findUnique({
    where: { emailDomain: domain },
  });
  if (existing) {
    return { organization: existing, created: false as const };
  }

  const organization = await prisma.organization.create({
    data: {
      name: titleCaseFromDomain(domain),
      emailDomain: domain,
    },
  });
  return { organization, created: true as const };
}
