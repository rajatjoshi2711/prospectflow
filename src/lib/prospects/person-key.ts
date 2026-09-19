/**
 * URL encoding for the stable person key.
 *
 * WHY THE PROSPECT PAGE IS ADDRESSED BY `identityKey` AND NOT BY `Connection.id`
 * -----------------------------------------------------------------------------
 * `Connection` rows are written fresh on every import: a new batch means a new
 * set of ids, and the dashboards read the latest COMPLETE batch. A
 * `/prospects/<connectionId>` URL would therefore 404 the moment the user
 * uploads again, taking every bookmark and every shared link with it.
 * `identityKey` (`src/lib/ingestion/identity-key.ts`) is the key that already
 * survives re-imports — it is what `ConnectionMark` is stored against and what
 * `src/lib/campaigns/link.ts` re-links leads with — so the page is addressed by
 * that instead.
 *
 * `identityKey` values look like `url:https://www.linkedin.com/in/jane-doe` or
 * `fallback:<sha256 hex>`. The `:` and `/` characters are not path-safe, so the
 * key is base64url encoded in the URL. Encoding and decoding live together in
 * this one module so the two sides can never drift apart.
 *
 * `btoa`/`atob` rather than `Buffer`: this module is imported by the client
 * component that builds the links as well as by the server that reads them, and
 * `btoa`/`atob` are global in browsers and in Node 16+. They are latin1-only,
 * hence the explicit UTF-8 encode/decode around them — a profile URL can carry
 * non-ASCII characters.
 */

/**
 * The base64url primitives, exported so that OTHER things addressed by a
 * free-text key use this exact scheme rather than inventing a second one.
 * `src/lib/companies/company-key.ts` is the other consumer: a company key is
 * derived from a CSV-supplied company name and carries the same problem
 * characters (`/`, `.`, `&`, spaces, non-ASCII), so it is encoded identically.
 * One implementation means the two sides can never drift apart.
 */
export function encodeUrlKey(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function encodePersonKey(identityKey: string): string {
  return encodeUrlKey(identityKey);
}

/**
 * Returns null for anything that is not a well-formed encoding of a non-empty
 * key. The caller turns that into a 404: a malformed key names nothing, and it
 * must never be passed into a query as a raw string.
 */
export function decodeUrlKey(encoded: string): string | null {
  if (!encoded || encoded.length > 2048) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;

  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);

  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    // `fatal` so invalid UTF-8 throws instead of silently becoming U+FFFD,
    // which would let a corrupted key reach the database as a near-miss string.
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function decodePersonKey(encoded: string): string | null {
  return decodeUrlKey(encoded);
}

/**
 * The canonical link to a person's page.
 *
 * `from` carries the list the reader came from so the detail page can offer a
 * way back to it, following the pattern in the campaign detail page. It is only
 * ever a path within this app — the detail page re-validates it before
 * rendering, because a query parameter is reader-supplied input.
 */
export function prospectHref(identityKey: string, from?: string | null): string {
  const base = `/prospects/${encodePersonKey(identityKey)}`;
  if (!from) return base;
  return `${base}?from=${encodeURIComponent(from)}`;
}
