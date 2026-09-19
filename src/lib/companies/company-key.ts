/**
 * URL encoding for a company group.
 *
 * A company is addressed by its NORMALISED key (`companyKeySql` /
 * `normalizeCompanyName`), not by the raw spelling: the raw string is one of
 * several that fold into the same group, so a raw-spelling URL would name one
 * arbitrary variant of the employer rather than the employer.
 *
 * Even normalised, the key is free text off a CSV and can carry spaces and
 * non-ASCII characters, so it is base64url encoded exactly the way a person
 * key is — same `encodeUrlKey`/`decodeUrlKey` primitives, deliberately not a
 * second scheme. See `src/lib/prospects/person-key.ts`.
 */

import { decodeUrlKey, encodeUrlKey } from "@/lib/prospects/person-key";

export function encodeCompanyKey(companyKey: string): string {
  return encodeUrlKey(companyKey);
}

/** Null for a malformed key; the caller turns that into a 404. */
export function decodeCompanyKey(encoded: string): string | null {
  return decodeUrlKey(encoded);
}

/**
 * `from` carries the list the reader arrived from, matching `prospectHref`, so
 * the company page can offer a way back to the exact page of results.
 */
export function companyHref(companyKey: string, from?: string | null): string {
  const base = `/companies/${encodeCompanyKey(companyKey)}`;
  if (!from) return base;
  return `${base}?from=${encodeURIComponent(from)}`;
}
