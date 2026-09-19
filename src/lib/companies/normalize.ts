/**
 * COMPANY IDENTITY — grouping free text into employers.
 *
 * WHAT WE ACTUALLY HAVE
 * ---------------------
 * `Connection.company` is a string a person typed into their own LinkedIn
 * profile. There is no company id, no domain, no registry number. The same
 * employer therefore arrives as "Acme Inc.", "Acme, Inc", "ACME", "Acme Inc"
 * and "acme  inc." in one export. Grouping on the raw string produces five
 * "companies" with one person each, which is worse than not grouping at all
 * because it looks like an answer.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * It defines ONE normalisation, used for grouping only:
 *
 *   1. lowercase and trim
 *   2. `&` becomes ` and ` — "Smith & Co" and "Smith and Co" are one employer
 *   3. every run of non-alphanumeric characters becomes a single space, which
 *      folds commas, full stops, hyphens, slashes and doubled spaces at once.
 *      `[:alnum:]` is used rather than `a-z0-9` so that a company written in a
 *      non-Latin script survives instead of being erased to an empty string.
 *   4. trailing legal-form suffixes are stripped, repeatedly, so "Acme Pvt
 *      Ltd" and "Acme" meet.
 *
 * THE SUFFIX LIST IS DELIBERATELY NARROW. It contains legal forms only
 * (inc, ltd, llc, gmbh, pvt, …). Words like "group", "holdings",
 * "technologies", "labs" or "solutions" are NOT stripped even though they are
 * common company-name filler, because stripping them merges genuinely
 * different employers — "Acme Group" and "Acme Technologies" can be unrelated
 * companies, and a wrong merge is a much worse error here than a missed one.
 * This normalisation is intentionally conservative in that direction.
 *
 * WHAT IT CANNOT DO, AND WHY THE UI SAYS SO
 * -----------------------------------------
 * It cannot know that "IBM" and "International Business Machines" are one
 * employer, that "Acme (EMEA)" is a division of "Acme", or that two unrelated
 * consultancies both called "Apex" are two employers and not one. Those need a
 * company registry or a domain, and a LinkedIn export carries neither. So the
 * /companies views state plainly that grouping is approximate and show how
 * many distinct raw spellings were folded into each row — the reader can see
 * the evidence and judge it, rather than being handed a number that implies a
 * certainty we do not have.
 *
 * TWO IMPLEMENTATIONS, ONE RULE SET
 * ---------------------------------
 * The grouping happens in SQL (`companyKeySql`), because normalising in
 * JavaScript would mean pulling every connection row in the batch out of
 * Postgres just to bucket it — thousands of rows on every page load. The
 * TypeScript twin (`normalizeCompanyName`) exists for ONE job: normalising the
 * reader's search term so that typing "Acme, Inc." finds the "acme" group. The
 * two must stay in step; both are driven by `LEGAL_SUFFIXES` below, and any
 * change to the steps above has to be made in both.
 */

/**
 * Legal-form tokens stripped from the END of a company name. Lowercase, no
 * punctuation (punctuation is already gone by the time this is applied).
 */
export const LEGAL_SUFFIXES = [
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "llc",
  "llp",
  "lllp",
  "lp",
  "plc",
  "gmbh",
  "mbh",
  "ag",
  "kg",
  "kgaa",
  "ug",
  "bv",
  "nv",
  "sa",
  "sas",
  "sarl",
  "srl",
  "spa",
  "sl",
  "ab",
  "as",
  "asa",
  "oy",
  "oyj",
  "aps",
  "pty",
  "pvt",
  "private",
  "pte",
  "sdn",
  "bhd",
  "kk",
  "dba",
] as const;

const SUFFIX_ALTERNATION = LEGAL_SUFFIXES.join("|");

/**
 * The normalisation as a SQL expression over a text column.
 *
 * `column` MUST be a trusted identifier written by this codebase — it is
 * interpolated, not parameterised, because a column reference cannot be a bind
 * parameter. Callers pass literals like `c."company"`; never pass user input.
 *
 * Returns NULL when the input is null/blank, so callers can filter on
 * `IS NOT NULL` rather than comparing against an empty-string sentinel.
 *
 * The COALESCE at the end is not decoration: a company recorded as literally
 * "Inc." or "Ltd" would be stripped to nothing, and falling back to the
 * pre-strip form keeps it as its own (odd but honest) group instead of
 * silently vanishing.
 */
export function companyKeySql(column: string): string {
  const base = `btrim(regexp_replace(regexp_replace(lower(btrim(${column})), '&', ' and ', 'g'), '[^[:alnum:]]+', ' ', 'g'))`;
  const stripped = `btrim(regexp_replace(${base}, '( (${SUFFIX_ALTERNATION}))+$', '', 'g'))`;
  return `COALESCE(NULLIF(${stripped}, ''), NULLIF(${base}, ''))`;
}

/**
 * The TypeScript twin of `companyKeySql`, for normalising a search term.
 *
 * `\p{L}\p{N}` mirrors Postgres `[:alnum:]` — letters and numbers in any
 * script — so a non-Latin company name normalises the same way on both sides.
 * Returns "" when nothing survives, which callers read as "no usable term".
 */
export function normalizeCompanyName(raw: string | null | undefined): string {
  if (!raw) return "";
  const base = raw
    .toLowerCase()
    // Drop STANDALONE combining marks, and only those.
    //
    // `toLowerCase()` on some letters emits a base letter plus a combining
    // mark — Turkish "İ" becomes "i" + U+0307. The `\p{L}\p{N}` filter below
    // treats that mark as a separator, so "İstanbul" would normalise to
    // "i stanbul" here while Postgres's `lower()` gives "istanbul". The two
    // sides would then disagree and searching for such a company would find
    // nothing.
    //
    // `\p{Mn}` without an NFD decomposition first is deliberate: precomposed
    // letters like "é" (U+00E9) are a single code point and are left intact,
    // matching Postgres, which also keeps them. Decomposing first would strip
    // every accent and re-introduce the same disagreement from the other side.
    .normalize("NFC")
    .replace(/\p{Mn}/gu, "")
    .trim()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!base) return "";
  const stripped = base.replace(new RegExp(`( (${SUFFIX_ALTERNATION}))+$`), "").trim();
  return stripped || base;
}
