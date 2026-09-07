import { createHash } from "node:crypto";

/**
 * Person keys used to link rows across CSVs and across import batches.
 *
 * A LinkedIn export identifies people two incompatible ways:
 *   - `Connections.csv` has a profile URL (stable, globally unique).
 *   - `messages.csv` / `Invitations.csv` identify the counterparty by
 *     DISPLAY NAME. Older exports carry no profile URL for them at all.
 *
 * A single key column therefore cannot join those tables: a URL-derived key
 * and a name-derived key live in disjoint key spaces. So every person-bearing
 * table stores TWO keys:
 *
 *   `identityKey` — the strong key. `url:<normalized profile url>` when a URL
 *                   is available, otherwise `fallback:sha256(name+company)`.
 *                   Preserved from Phase 2 so existing rows keep their meaning.
 *   `nameKey`     — the weak key. `name:<normalized display name>`, set
 *                   whenever any name is known.
 *
 * Joins match on `identityKey` first and fall back to `nameKey`.
 *
 * LIMITATION (deliberate, not a bug): `nameKey` is NOT unique. Two different
 * people called "John Smith" collapse to the same `nameKey`, so a name-key
 * fallback join can attribute one person's messages to the other. It is the
 * best that a name-only export row supports. Anything derived purely from a
 * name-key match should be treated as a strong hint, not as fact, and must
 * never be the sole basis for an irreversible action. Where a profile URL is
 * present on BOTH sides the `identityKey` match is exact and is always
 * preferred.
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

/**
 * Lowercases, trims and collapses whitespace in a display name, so
 * `"  Jane   Doe "` and `"Jane Doe"` normalize identically. Returns `""`
 * when nothing usable is left.
 */
export function normalizeDisplayName(name?: string | null): string {
  return (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** `normalizeDisplayName` over separate first/last name columns. */
export function normalizeNameParts(
  firstName?: string | null,
  lastName?: string | null,
): string {
  return normalizeDisplayName([firstName ?? "", lastName ?? ""].join(" "));
}

/**
 * The weak, name-based key. Returns null when there is no usable name, so a
 * blank name never becomes a key that matches every other blank name.
 */
export function computeNameKey(name?: string | null): string | null {
  const normalized = normalizeDisplayName(name);
  return normalized ? `name:${normalized}` : null;
}

/** `computeNameKey` over separate first/last name columns. */
export function computeNameKeyFromParts(
  firstName?: string | null,
  lastName?: string | null,
): string | null {
  return computeNameKey(normalizeNameParts(firstName, lastName));
}
