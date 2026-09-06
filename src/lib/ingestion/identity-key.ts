import { createHash } from "node:crypto";

/**
 * Computes a stable per-person identity key so the same connection can be
 * matched across import batches (and across CSVs within a batch).
 *
 * Preference order per the build plan:
 *   1. Normalized LinkedIn URL, when present.
 *   2. sha256(lower(firstName + lastName + company)) as a fallback.
 */
export function computeIdentityKey(input: {
  linkedinUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
}): string {
  const normalizedUrl = normalizeLinkedinUrl(input.linkedinUrl);
  if (normalizedUrl) {
    return `url:${normalizedUrl}`;
  }

  const raw = `${input.firstName ?? ""}${input.lastName ?? ""}${input.company ?? ""}`
    .trim()
    .toLowerCase();
  const hash = createHash("sha256").update(raw).digest("hex");
  return `fallback:${hash}`;
}

/**
 * Normalizes a LinkedIn profile URL so trivial differences (protocol,
 * www, trailing slash, query string, casing) don't produce different
 * identity keys for the same person.
 */
export function normalizeLinkedinUrl(url?: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "");
  }
}
